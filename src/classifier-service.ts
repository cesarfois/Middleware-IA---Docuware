import { ClassifierStore } from './classifier-store.js';
import { config } from './config.js';
import {
  DocuWarePlatformClient,
  DocuWareServiceError,
  defaultDocuWareClient,
} from './docuware-client.js';
import {
  executeModelTraining,
  normalizeCategoryName,
  predictWithModelArtifact,
  preprocessOcrForMl,
  type TrainingSampleInput,
} from './ml-engine.js';
import type {
  ClassifyRequestBody,
  ClassifyResponse,
  NormalizedClassifyRequest,
  NormalizedTrainRequest,
  TrainHistoryItem,
  TrainHistoryQueryParams,
  TrainHistoryResponse,
  TrainImmediateResponse,
  TrainRequestBody,
  TrainStatusResponse,
  TrainSummaryCategoryItem,
  TrainSummaryResponse,
  TrainingJobStatus,
  TrainingOperationType,
} from './types.js';

export class ClassifierValidationError extends Error {
  public readonly code:
    | 'INVALID_REQUEST'
    | 'TRAINING_JOB_NOT_FOUND'
    | 'MODEL_NOT_READY'
    | 'INSUFFICIENT_OCR_TEXT'
    | 'CLASSIFICATION_FAILED';
  public readonly statusCode: number;

  constructor(
    code: ClassifierValidationError['code'],
    message: string,
    statusCode = 400
  ) {
    super(message);
    this.name = 'ClassifierValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function validateAndNormalizeTrainRequest(
  body: unknown
): NormalizedTrainRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O corpo da requisição deve ser um objeto JSON válido contendo "fileCabinetId", "documentId" e "documentType".',
      400
    );
  }

  const raw = body as TrainRequestBody;

  if (
    typeof raw.fileCabinetId !== 'string' ||
    raw.fileCabinetId.trim().length === 0
  ) {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O campo "fileCabinetId" é obrigatório e deve ser uma string não vazia.',
      400
    );
  }

  let docId: number;
  if (typeof raw.documentId === 'number' && Number.isInteger(raw.documentId)) {
    docId = raw.documentId;
  } else if (
    typeof raw.documentId === 'string' &&
    /^\d+$/.test(raw.documentId.trim())
  ) {
    docId = Number.parseInt(raw.documentId.trim(), 10);
  } else {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O campo "documentId" é obrigatório e deve ser um número inteiro positivo.',
      400
    );
  }

  if (docId <= 0) {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O campo "documentId" deve ser maior que zero.',
      400
    );
  }

  if (
    typeof raw.documentType !== 'string' ||
    raw.documentType.trim().length < 2
  ) {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O campo "documentType" é obrigatório e deve conter o nome do tipo documental (mínimo 2 caracteres).',
      400
    );
  }

  const { categoryKey, displayName } = normalizeCategoryName(raw.documentType);
  if (!categoryKey) {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O campo "documentType" contém apenas caracteres inválidos.',
      400
    );
  }

  return {
    fileCabinetId: raw.fileCabinetId.trim(),
    documentId: docId,
    documentTypeDisplay: displayName,
    categoryKey,
  };
}

export function validateAndNormalizeClassifyRequest(
  body: unknown
): NormalizedClassifyRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O corpo da requisição deve ser um objeto JSON válido contendo "fileCabinetId" e "documentId".',
      400
    );
  }

  const raw = body as ClassifyRequestBody;

  if (
    typeof raw.fileCabinetId !== 'string' ||
    raw.fileCabinetId.trim().length === 0
  ) {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O campo "fileCabinetId" é obrigatório e deve ser uma string não vazia.',
      400
    );
  }

  let docId: number;
  if (typeof raw.documentId === 'number' && Number.isInteger(raw.documentId)) {
    docId = raw.documentId;
  } else if (
    typeof raw.documentId === 'string' &&
    /^\d+$/.test(raw.documentId.trim())
  ) {
    docId = Number.parseInt(raw.documentId.trim(), 10);
  } else {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O campo "documentId" é obrigatório e deve ser um número inteiro positivo.',
      400
    );
  }

  if (docId <= 0) {
    throw new ClassifierValidationError(
      'INVALID_REQUEST',
      'O campo "documentId" deve ser maior que zero.',
      400
    );
  }

  return {
    fileCabinetId: raw.fileCabinetId.trim(),
    documentId: docId,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serviço de Aprendizagem Supervisionada e Classificação Automática Local.
 * Gere a fila assíncrona persistente, extração controlada de Textshot, validação cruzada,
 * versionamento atómico de modelos e inferência calibrada.
 */
export class ClassifierService {
  private readonly store: ClassifierStore;
  private readonly dwClient: DocuWarePlatformClient;
  private activeWorkers = 0;
  private trainingInProgress = false;
  private pendingTrainingTrigger = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    customStore?: ClassifierStore,
    customDwClient?: DocuWarePlatformClient
  ) {
    this.store = customStore ?? new ClassifierStore();
    this.dwClient = customDwClient ?? defaultDocuWareClient;
  }

  public getStore(): ClassifierStore {
    return this.store;
  }

  /**
   * Recupera trabalhos interrompidos num reinício anterior e retoma o processamento da fila.
   */
  public recoverAndResumeQueue(): number {
    const recoveredCount = this.store.recoverInterruptedJobs();
    const pending = this.store.getPendingOrInterruptedJobs();
    if (pending.length > 0) {
      this.scheduleWorkerPump();
    }
    return recoveredCount;
  }

  /**
   * Submete um documento individual para aprendizagem supervisionada assíncrona (`POST /train`).
   */
  public enqueueTrainingDocument(
    req: NormalizedTrainRequest
  ): TrainImmediateResponse {
    const job = this.store.createTrainingJob({
      fileCabinetId: req.fileCabinetId,
      documentId: req.documentId,
      categoryKey: req.categoryKey,
      displayName: req.documentTypeDisplay,
    });

    this.scheduleWorkerPump();

    return {
      success: true,
      trainingId: job.trainingId,
      documentId: job.documentId,
      fileCabinetId: job.fileCabinetId,
      documentType: job.displayName,
      status: job.status,
      message: 'Exemplo recebido e colocado em fila para aprendizagem.',
    };
  }

  /**
   * Consulta o estado detalhado de um trabalho de aprendizagem (`GET /train/status`).
   */
  public getTrainingStatus(trainingId: string): TrainStatusResponse {
    const cleanId = trainingId.trim();
    if (!cleanId) {
      throw new ClassifierValidationError(
        'INVALID_REQUEST',
        'O parâmetro de query "trainingId" é obrigatório.',
        400
      );
    }

    const job = this.store.getTrainingJob(cleanId);
    if (!job) {
      throw new ClassifierValidationError(
        'TRAINING_JOB_NOT_FOUND',
        `Trabalho de aprendizagem "${cleanId}" não encontrado.`,
        404
      );
    }

    const category = this.store.getCategory(job.categoryKey);
    const activeModel = this.store.getActiveModel();
    const eligibleCategoriesCount = this.store
      .getAllCategories()
      .filter(
        (c) => c.examplesCount >= config.classifierMinExamplesPerCategory
      ).length;
    const isTerminalStatus =
      job.status === 'stored' ||
      job.status === 'learned' ||
      job.status === 'rejected' ||
      job.status === 'failed';

    return {
      success: true,
      trainingId: job.trainingId,
      status: job.status,
      jobFinished: isTerminalStatus,
      documentId: job.documentId,
      fileCabinetId: job.fileCabinetId,
      documentType: job.displayName,
      category: {
        status: category?.status ?? 'pending_validation',
        examplesReceived: category?.examplesCount ?? 0,
        minimumExamples: config.classifierMinExamplesPerCategory,
        eligibleCategoriesCount,
        minimumCategoriesForModel: config.classifierMinCategoriesForModel,
        active: category?.status === 'active',
      },
      model: {
        version: job.modelVersion ?? category?.activeModelVersion ?? activeModel?.version ?? null,
        validationAccuracy:
          job.validationAccuracy ?? activeModel?.report.accuracy ?? null,
      },
      details: {
        textshotRetrieved: job.textshotRetrieved,
        exampleStored: job.exampleStored,
        includedInModel: job.includedInModel,
        isIdempotentDuplicate: Boolean(job.isIdempotentDuplicate),
        wasCorrection: job.wasCorrection,
        previousDocumentType: job.previousDocumentType,
        operationType:
          job.operationType ??
          (job.status === 'rejected'
            ? 'rejected'
            : job.status === 'failed'
            ? 'failed'
            : !isTerminalStatus
            ? 'pending'
            : job.wasCorrection
            ? 'label_correction'
            : job.isIdempotentDuplicate
            ? 'idempotent_duplicate'
            : 'new_example'),
        attempts: job.attempts,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
      },
      message: job.statusMessage,
    };
  }

  /**
   * Consulta o resumo geral do sistema de aprendizagem e do modelo ativo (`GET /train/summary`).
   */
  public getTrainingSummary(): TrainSummaryResponse {
    const activeModel = this.store.getActiveModel();
    const allCategories = this.store.getAllCategories();
    const allExamples = this.store.getAllExamples();
    const allJobs = this.store.getAllJobs();
    const minExamples = config.classifierMinExamplesPerCategory;
    const minCats = config.classifierMinCategoriesForModel;

    const isModelActive = Boolean(
      activeModel && activeModel.categories.length >= minCats
    );

    let modelValidation: {
      accuracy: number;
      macroF1: number;
      weightedF1: number;
    } | null = null;

    if (isModelActive && activeModel) {
      const perCatList = Object.values(activeModel.report.perCategory ?? {});
      const totalSupport = perCatList.reduce(
        (acc, c) => acc + (c.support ?? 0),
        0
      );
      const weightedF1 =
        totalSupport > 0
          ? Number(
              (
                perCatList.reduce(
                  (acc, c) => acc + (c.support ?? 0) * c.f1Score,
                  0
                ) / totalSupport
              ).toFixed(4)
            )
          : activeModel.report.macroF1;

      modelValidation = {
        accuracy: activeModel.report.accuracy,
        macroF1: activeModel.report.macroF1,
        weightedF1,
      };
    }

    const categoriesList: TrainSummaryCategoryItem[] = allCategories
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt'))
      .map((cat) => {
        const catExamples = allExamples.filter(
          (ex) => ex.categoryKey === cat.categoryKey
        );
        const examplesReceived = catExamples.length;
        const isCatActive = Boolean(
          isModelActive &&
            activeModel &&
            activeModel.categories.includes(cat.categoryKey) &&
            cat.status === 'active'
        );
        const examplesIncludedInModel = isCatActive
          ? catExamples.filter(
              (ex) =>
                ex.status === 'learned' &&
                ex.includedInModelVersion === activeModel!.version
            ).length
          : 0;
        const pendingExamples = Math.max(
          0,
          examplesReceived - examplesIncludedInModel
        );

        const catReport =
          isCatActive && activeModel
            ? activeModel.report.perCategory[cat.categoryKey]
            : undefined;

        let lastExampleAt: string | null = null;
        for (const ex of catExamples) {
          const ts = ex.updatedAt || ex.createdAt;
          if (!lastExampleAt || ts.localeCompare(lastExampleAt) > 0) {
            lastExampleAt = ts;
          }
        }

        return {
          documentType: cat.displayName,
          status: isCatActive ? 'active' : 'pending_validation',
          examplesReceived,
          minimumExamples: minExamples,
          examplesIncludedInModel,
          pendingExamples,
          active: isCatActive,
          validation: catReport
            ? {
                precision: catReport.precision,
                recall: catReport.recall,
                f1: catReport.f1Score,
              }
            : null,
          lastExampleAt,
        };
      });

    const totalCategories = categoriesList.length;
    const activeCategories = categoriesList.filter((c) => c.active).length;
    const pendingCategories = categoriesList.filter((c) => !c.active).length;
    const eligibleCategories = categoriesList.filter(
      (c) => c.examplesReceived >= minExamples
    ).length;
    const totalExamples = allExamples.length;
    const learnedExamples = categoriesList.reduce(
      (acc, c) => acc + c.examplesIncludedInModel,
      0
    );
    const pendingExamples = Math.max(0, totalExamples - learnedExamples);

    const totalTrainingJobs = allJobs.length;
    const completedJobs = allJobs.filter(
      (j) => j.status === 'learned' || j.status === 'stored'
    ).length;
    const pendingJobs = allJobs.filter(
      (j) => j.status === 'queued' || j.status === 'processing'
    ).length;
    const failedJobs = allJobs.filter((j) => j.status === 'failed').length;
    const rejectedJobs = allJobs.filter((j) => j.status === 'rejected').length;

    return {
      success: true,
      model: {
        version: isModelActive && activeModel ? activeModel.version : null,
        status: isModelActive ? 'active' : 'not_ready',
        engine:
          isModelActive && activeModel
            ? activeModel.report.engine
            : config.classifierUsePythonEngine
            ? 'python_sklearn'
            : 'node_tfidf_logreg',
        trainedAt:
          isModelActive && activeModel
            ? activeModel.trainedAt ??
              activeModel.artifact.trainedAt ??
              activeModel.createdAt
            : null,
        activatedAt:
          isModelActive && activeModel
            ? activeModel.activatedAt ?? activeModel.createdAt
            : null,
        validation: modelValidation,
      },
      summary: {
        totalCategories,
        activeCategories,
        pendingCategories,
        eligibleCategories,
        totalExamples,
        learnedExamples,
        pendingExamples,
        totalTrainingJobs,
        completedJobs,
        pendingJobs,
        failedJobs,
        rejectedJobs,
      },
      categories: categoriesList,
    };
  }

  /**
   * Consulta o histórico paginado e filtrado de trabalhos de treinamento (`GET /train/history`).
   */
  public getTrainingHistory(
    rawParams: TrainHistoryQueryParams = {}
  ): TrainHistoryResponse {
    const validStatuses: Set<TrainingJobStatus> = new Set([
      'queued',
      'processing',
      'stored',
      'learned',
      'rejected',
      'failed',
    ]);

    let statusFilter: TrainingJobStatus | null = null;
    if (
      rawParams.status !== undefined &&
      String(rawParams.status).trim() !== ''
    ) {
      const s = String(rawParams.status).trim() as TrainingJobStatus;
      if (!validStatuses.has(s)) {
        throw new ClassifierValidationError(
          'INVALID_REQUEST',
          'O parâmetro "status" deve ser um dos valores: queued, processing, stored, learned, rejected, failed.',
          400
        );
      }
      statusFilter = s;
    }

    let categoryKeyFilter: string | null = null;
    if (
      rawParams.documentType !== undefined &&
      String(rawParams.documentType).trim() !== ''
    ) {
      const normalized = normalizeCategoryName(String(rawParams.documentType));
      if (!normalized.categoryKey) {
        throw new ClassifierValidationError(
          'INVALID_REQUEST',
          'O parâmetro "documentType" informado é inválido.',
          400
        );
      }
      categoryKeyFilter = normalized.categoryKey;
    }

    let fromMs: number | null = null;
    if (rawParams.from !== undefined && String(rawParams.from).trim() !== '') {
      const parsed = Date.parse(String(rawParams.from).trim());
      if (Number.isNaN(parsed)) {
        throw new ClassifierValidationError(
          'INVALID_REQUEST',
          'O parâmetro "from" deve ser uma data ISO 8601 válida.',
          400
        );
      }
      fromMs = parsed;
    }

    let toMs: number | null = null;
    if (rawParams.to !== undefined && String(rawParams.to).trim() !== '') {
      const rawTo = String(rawParams.to).trim();
      const parsed = Date.parse(rawTo);
      if (Number.isNaN(parsed)) {
        throw new ClassifierValidationError(
          'INVALID_REQUEST',
          'O parâmetro "to" deve ser uma data ISO 8601 válida.',
          400
        );
      }
      toMs = /^\d{4}-\d{2}-\d{2}$/.test(rawTo) ? parsed + 86_399_999 : parsed;
    }

    if (fromMs !== null && toMs !== null && fromMs > toMs) {
      throw new ClassifierValidationError(
        'INVALID_REQUEST',
        'O parâmetro "from" não pode ser posterior a "to".',
        400
      );
    }

    let limit = 50;
    if (
      rawParams.limit !== undefined &&
      String(rawParams.limit).trim() !== ''
    ) {
      const rawLimit = String(rawParams.limit).trim();
      if (!/^\d+$/.test(rawLimit)) {
        throw new ClassifierValidationError(
          'INVALID_REQUEST',
          'O parâmetro "limit" deve ser um número inteiro entre 1 e 200.',
          400
        );
      }
      const parsedLimit = Number.parseInt(rawLimit, 10);
      if (parsedLimit < 1 || parsedLimit > 200) {
        throw new ClassifierValidationError(
          'INVALID_REQUEST',
          'O parâmetro "limit" deve estar entre 1 e 200.',
          400
        );
      }
      limit = parsedLimit;
    }

    let cursorJob: { createdAt: string; trainingId: string } | null = null;
    if (
      rawParams.cursor !== undefined &&
      String(rawParams.cursor).trim() !== ''
    ) {
      const cleanCursor = String(rawParams.cursor).trim();
      const existingCursorJob = this.store.getTrainingJob(cleanCursor);
      if (!existingCursorJob) {
        throw new ClassifierValidationError(
          'INVALID_REQUEST',
          `Cursor de paginação "${cleanCursor}" inválido ou inexistente.`,
          400
        );
      }
      cursorJob = {
        createdAt: existingCursorJob.createdAt,
        trainingId: existingCursorJob.trainingId,
      };
    }

    const filteredJobs = this.store
      .getAllJobs()
      .filter((job) => {
        if (categoryKeyFilter && job.categoryKey !== categoryKeyFilter) {
          return false;
        }
        if (statusFilter && job.status !== statusFilter) {
          return false;
        }
        if (fromMs !== null || toMs !== null) {
          const jobTime = Date.parse(job.createdAt);
          if (fromMs !== null && jobTime < fromMs) return false;
          if (toMs !== null && jobTime > toMs) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const cmpDate = b.createdAt.localeCompare(a.createdAt);
        if (cmpDate !== 0) return cmpDate;
        return b.trainingId.localeCompare(a.trainingId);
      });

    const totalMatching = filteredJobs.length;

    const afterCursorJobs = cursorJob
      ? filteredJobs.filter((job) => {
          const cmpDate = job.createdAt.localeCompare(cursorJob!.createdAt);
          if (cmpDate < 0) return true;
          if (cmpDate > 0) return false;
          return job.trainingId.localeCompare(cursorJob!.trainingId) < 0;
        })
      : filteredJobs;

    const pageJobs = afterCursorJobs.slice(0, limit);
    const hasMore = afterCursorJobs.length > limit;
    const nextCursor =
      hasMore && pageJobs.length > 0
        ? pageJobs[pageJobs.length - 1]!.trainingId
        : null;

    const items: TrainHistoryItem[] = pageJobs.map((job) => {
      const jobFinished =
        job.status === 'stored' ||
        job.status === 'learned' ||
        job.status === 'rejected' ||
        job.status === 'failed';

      const isIdempotentDuplicate = Boolean(job.isIdempotentDuplicate);
      const operationType: TrainingOperationType =
        job.operationType ??
        (job.status === 'rejected'
          ? 'rejected'
          : job.status === 'failed'
          ? 'failed'
          : !jobFinished
          ? 'pending'
          : job.wasCorrection
          ? 'label_correction'
          : isIdempotentDuplicate
          ? 'idempotent_duplicate'
          : 'new_example');

      return {
        trainingId: job.trainingId,
        fileCabinetId: job.fileCabinetId,
        documentId: job.documentId,
        documentType: job.displayName,
        status: job.status,
        jobFinished,
        operationType,
        isIdempotentDuplicate,
        includedInModel: job.includedInModel,
        modelVersion: job.modelVersion ?? null,
        wasCorrection: job.wasCorrection,
        previousDocumentType: job.previousDocumentType ?? null,
        attempts: job.attempts,
        errorCode: job.errorCode ?? null,
        createdAt: job.createdAt,
        completedAt: job.completedAt ?? null,
      };
    });

    return {
      success: true,
      totalMatching,
      count: items.length,
      limit,
      nextCursor,
      hasMore,
      items,
    };
  }

  /**
   * Classifica um documento armazenado no DocuWare utilizando exclusivamente o modelo local ativo (`POST /classify`).
   */
  public async classifyDocument(
    req: NormalizedClassifyRequest
  ): Promise<ClassifyResponse> {
    const startTime = Date.now();
    const activeModel = this.store.getActiveModel();

    if (
      !activeModel ||
      activeModel.categories.length < config.classifierMinCategoriesForModel
    ) {
      throw new ClassifierValidationError(
        'MODEL_NOT_READY',
        `Nenhum modelo discriminativo está ativo no momento. É necessário validar pelo menos ${config.classifierMinCategoriesForModel} categorias distintas com o mínimo de ${config.classifierMinExamplesPerCategory} exemplos válidos cada.`,
        422
      );
    }

    // Recupera o Textshot do DocuWare (sem truncar a 2000 caracteres; usa o limite próprio do classificador)
    const textshotResult = await this.dwClient.retrieveDocumentTextshot({
      fileCabinetId: req.fileCabinetId,
      documentId: req.documentId,
      options: {
        includePages: true,
        includeCoordinates: false,
        normalize: true,
        output: 'text',
        maxCharacters: config.classifierMaxFeatureChars,
      },
    });

    const featureText = this.extractFeatureTextFromTextshot(
      textshotResult.text,
      textshotResult.pages
    );
    const { normalizedText, tokenCount } = preprocessOcrForMl(featureText);

    // Se o documento tiver OCR insuficiente ou quase vazio, encaminha para revisão manual
    if (
      normalizedText.length < config.classifierMinTextChars ||
      tokenCount < 3
    ) {
      return {
        success: true,
        status: 'needs_review',
        documentId: req.documentId,
        fileCabinetId: req.fileCabinetId,
        classification: {
          documentType: null,
          confidence: 0,
          requiresManualReview: true,
          secondBestDocumentType: null,
          secondBestConfidence: null,
        },
        model: {
          version: activeModel.version,
        },
        processingTimeMs: Date.now() - startTime,
        message:
          'Texto OCR insuficiente para classificação automática segura. Encaminhado para revisão manual.',
      };
    }

    const prediction = predictWithModelArtifact(
      normalizedText,
      activeModel.artifact,
      config.classifierMinConfidence,
      config.classifierMinMargin
    );

    if (prediction.status === 'needs_review') {
      return {
        success: true,
        status: 'needs_review',
        documentId: req.documentId,
        fileCabinetId: req.fileCabinetId,
        classification: {
          documentType: null,
          confidence: prediction.confidence,
          requiresManualReview: true,
          secondBestDocumentType: prediction.secondBestDocumentType,
          secondBestConfidence: prediction.secondBestConfidence,
        },
        model: {
          version: activeModel.version,
        },
        processingTimeMs: Date.now() - startTime,
        message:
          'Confiança insuficiente ou ambiguidade entre categorias. Encaminhado para revisão manual.',
      };
    }

    return {
      success: true,
      status: 'classified',
      documentId: req.documentId,
      fileCabinetId: req.fileCabinetId,
      classification: {
        documentType: prediction.documentType,
        confidence: prediction.confidence,
        requiresManualReview: false,
        secondBestDocumentType: prediction.secondBestDocumentType,
        secondBestConfidence: prediction.secondBestConfidence,
      },
      model: {
        version: activeModel.version,
      },
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Aguarda até que todos os workers da fila e treinos em curso terminem (útil para testes).
   */
  public async waitForIdle(): Promise<void> {
    const hasPendingJobs = () =>
      this.store
        .getPendingOrInterruptedJobs()
        .some((j) => j.status === 'queued' || j.status === 'processing');

    if (
      this.activeWorkers === 0 &&
      !this.trainingInProgress &&
      !hasPendingJobs()
    ) {
      return;
    }

    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
      this.scheduleWorkerPump();
    });
  }

  private checkAndNotifyIdle(): void {
    const pending = this.store.getPendingOrInterruptedJobs();
    if (
      this.activeWorkers === 0 &&
      !this.trainingInProgress &&
      pending.length === 0
    ) {
      const resolvers = this.idleResolvers.splice(0, this.idleResolvers.length);
      for (const r of resolvers) {
        r();
      }
    }
  }

  private scheduleWorkerPump(): void {
    setImmediate(() => {
      void this.pumpQueue();
    });
  }

  private async pumpQueue(): Promise<void> {
    while (this.activeWorkers < config.classifierWorkerConcurrency) {
      const nextJob = this.store
        .getPendingOrInterruptedJobs()
        .find((j) => j.status === 'queued');

      if (!nextJob) {
        break;
      }

      // Marca imediatamente como processing para evitar que outro worker pegue o mesmo job
      this.store.updateTrainingJob(nextJob.trainingId, {
        status: 'processing',
        statusMessage: 'A recuperar Textshot do DocuWare e a validar conteúdo OCR...',
      });

      this.activeWorkers += 1;
      void this.processSingleJob(nextJob.trainingId).finally(() => {
        this.activeWorkers -= 1;
        this.scheduleWorkerPump();
        this.checkAndNotifyIdle();
      });
    }

    this.checkAndNotifyIdle();
  }

  private extractFeatureTextFromTextshot(
    fullText: string,
    pages?: Array<{ pageNumber: number; text: string }>
  ): string {
    if (Array.isArray(pages) && pages.length > 0) {
      const selectedPages = pages.slice(0, config.classifierMaxFeaturePages);
      const joined = selectedPages
        .map((p) => p.text)
        .filter((t) => t && t.trim().length > 0)
        .join('\n\n');
      return joined.slice(0, config.classifierMaxFeatureChars);
    }
    return fullText.slice(0, config.classifierMaxFeatureChars);
  }

  private isTransientDocuWareError(err: unknown): boolean {
    if (err instanceof DocuWareServiceError) {
      return (
        err.code === 'DOCUWARE_TIMEOUT' ||
        err.code === 'DOCUWARE_API_ERROR' ||
        err.code === 'TEXTSHOT_NOT_AVAILABLE'
      );
    }
    return false;
  }

  private async processSingleJob(trainingId: string): Promise<void> {
    const job = this.store.getTrainingJob(trainingId);
    if (!job) return;

    const maxAttempts = Math.max(1, config.classifierMaxJobAttempts);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.store.updateTrainingJob(trainingId, {
        attempts: attempt,
        status: 'processing',
      });

      try {
        const textshot = await this.dwClient.retrieveDocumentTextshot({
          fileCabinetId: job.fileCabinetId,
          documentId: job.documentId,
          options: {
            includePages: true,
            includeCoordinates: false,
            normalize: true,
            output: 'text',
            maxCharacters: config.classifierMaxFeatureChars,
          },
        });

        const featureText = this.extractFeatureTextFromTextshot(
          textshot.text,
          textshot.pages
        );
        const { normalizedText, textHash, tokenCount } =
          preprocessOcrForMl(featureText);

        // Regra: Rejeitar documentos sem texto OCR suficiente
        if (
          normalizedText.length < config.classifierMinTextChars ||
          tokenCount < 3
        ) {
          const rejectMsg = `Documento rejeitado para treino: texto OCR insuficiente (${normalizedText.length} caracteres úteis, mínimo exigido: ${config.classifierMinTextChars}).`;
          this.store.updateTrainingJob(trainingId, {
            status: 'rejected',
            textshotRetrieved: true,
            exampleStored: false,
            includedInModel: false,
            isIdempotentDuplicate: false,
            wasCorrection: false,
            operationType: 'rejected',
            errorCode: 'INSUFFICIENT_OCR_TEXT',
            errorMessage: rejectMsg,
            statusMessage: rejectMsg,
            completedAt: new Date().toISOString(),
          });
          this.store.recordAuditEvent({
            trainingId,
            fileCabinetId: job.fileCabinetId,
            documentId: job.documentId,
            eventType: 'job_rejected',
            errorCode: 'INSUFFICIENT_OCR_TEXT',
            message: rejectMsg,
          });
          return;
        }

        // Guarda ou atualiza o exemplo (idempotente para duplicado da mesma categoria; correção se categoria mudou)
        const upsertResult = this.store.upsertExample({
          fileCabinetId: job.fileCabinetId,
          documentId: job.documentId,
          categoryKey: job.categoryKey,
          displayName: job.displayName,
          normalizedText,
          textHash,
          charCount: normalizedText.length,
          pageCount: textshot.pageCount,
          trainingId,
        });

        const cat = this.store.getCategory(job.categoryKey);
        const countNow = cat?.examplesCount ?? 1;
        const minReq = config.classifierMinExamplesPerCategory;
        const minCats = config.classifierMinCategoriesForModel;
        const eligibleCatsNow = this.store
          .getAllCategories()
          .filter((c) => c.examplesCount >= minReq).length;

        const jobOperationType: TrainingOperationType = upsertResult.wasCorrection
          ? 'label_correction'
          : upsertResult.isDuplicateSameCategory
          ? 'idempotent_duplicate'
          : 'new_example';

        // Se for duplicado idempotente e o exemplo já estiver learned no modelo ativo
        if (
          upsertResult.isDuplicateSameCategory &&
          upsertResult.example.status === 'learned' &&
          upsertResult.example.includedInModelVersion
        ) {
          const activeModel = this.store.getActiveModel();
          this.store.updateTrainingJob(trainingId, {
            status: 'learned',
            textshotRetrieved: true,
            exampleStored: true,
            includedInModel: true,
            isIdempotentDuplicate: true,
            wasCorrection: false,
            operationType: 'idempotent_duplicate',
            modelVersion: upsertResult.example.includedInModelVersion,
            validationAccuracy: activeModel?.report.accuracy ?? null,
            errorCode: null,
            errorMessage: null,
            statusMessage: `Documento já aprendido anteriormente na categoria "${job.displayName}" (modelo ${upsertResult.example.includedInModelVersion}). Contagem mantida em ${countNow} exemplos.`,
            completedAt: new Date().toISOString(),
          });
          return;
        }

        const baseStoredMsg = upsertResult.wasCorrection
          ? `Rótulo corrigido de "${upsertResult.previousDisplayName}" para "${job.displayName}". Categoria possui agora ${countNow}/${minReq} exemplos.`
          : upsertResult.isDuplicateSameCategory
          ? `Documento já registado na categoria "${job.displayName}" (idempotente). Categoria possui ${countNow}/${minReq} exemplos.`
          : countNow < minReq
          ? `Exemplo válido guardado com sucesso (${countNow}/${minReq} exemplos necessários para a categoria "${job.displayName}").`
          : eligibleCatsNow < minCats
          ? `A categoria "${job.displayName}" atingiu ${countNow}/${minReq} exemplos válidos. O treino e validação do modelo serão iniciados automaticamente assim que existir pelo menos ${minCats} categorias com ${minReq} exemplos cada para comparação discriminativa (atualmente: ${eligibleCatsNow}/${minCats} categorias elegíveis).`
          : `Exemplo válido guardado (${countNow}/${minReq}). A iniciar treino e validação discriminativa automática do modelo...`;

        this.store.updateTrainingJob(trainingId, {
          status: 'stored',
          textshotRetrieved: true,
          exampleStored: true,
          includedInModel: false,
          isIdempotentDuplicate: upsertResult.isDuplicateSameCategory,
          wasCorrection: upsertResult.wasCorrection,
          previousDocumentType: upsertResult.previousDisplayName,
          operationType: jobOperationType,
          errorCode: null,
          errorMessage: null,
          statusMessage: baseStoredMsg,
          completedAt: new Date().toISOString(),
        });

        // Se não houver outros exemplos aguardando na fila imediata, dispara a avaliação/treino agora;
        // caso contrário, o treino será executado assim que o lote atual da fila terminar de guardar os exemplos.
        const hasMoreQueued = this.store
          .getPendingOrInterruptedJobs()
          .some((j) => j.status === 'queued');
        if (!hasMoreQueued) {
          await this.evaluateAndTrainModelIfNeeded();
        }
        return;
      } catch (err) {
        lastError = err;
        const isTransient = this.isTransientDocuWareError(err);

        if (isTransient && attempt < maxAttempts) {
          const delayMs = config.classifierJobRetryDelayMs * attempt;
          this.store.updateTrainingJob(trainingId, {
            statusMessage: `Falha temporária ao consultar DocuWare (tentativa ${attempt}/${maxAttempts}). Nova tentativa em ${delayMs}ms...`,
          });
          await sleep(delayMs);
          continue;
        }
        break;
      }
    }

    // Se todas as tentativas falharam ou o erro for permanente (ex: 404 DOCUMENT_NOT_FOUND)
    const errCode =
      lastError instanceof DocuWareServiceError
        ? lastError.code
        : 'INTERNAL_TRAINING_ERROR';
    const errMsg =
      lastError instanceof Error
        ? lastError.message
        : 'Erro inesperado durante o processamento do documento para aprendizagem.';

    this.store.updateTrainingJob(trainingId, {
      status: 'failed',
      exampleStored: false,
      includedInModel: false,
      isIdempotentDuplicate: false,
      wasCorrection: false,
      operationType: 'failed',
      errorCode: errCode,
      errorMessage: errMsg,
      statusMessage: `Falha ao processar exemplo: ${errMsg}`,
      completedAt: new Date().toISOString(),
    });

    this.store.recordAuditEvent({
      trainingId,
      fileCabinetId: job.fileCabinetId,
      documentId: job.documentId,
      eventType: 'job_error',
      errorCode: errCode,
      message: errMsg,
    });
  }

  /**
   * Verifica se há categorias elegíveis (>= mínimo de exemplos) com exemplos `stored` pendentes
   * de incorporação no modelo ou após correções supervisionadas, e executa o treino e validação.
   */
  public async evaluateAndTrainModelIfNeeded(): Promise<void> {
    if (this.trainingInProgress) {
      this.pendingTrainingTrigger = true;
      return;
    }

    this.trainingInProgress = true;
    try {
      do {
        this.pendingTrainingTrigger = false;
        await this.runModelTrainingCycle();
      } while (this.pendingTrainingTrigger);
    } finally {
      this.trainingInProgress = false;
      this.checkAndNotifyIdle();
    }
  }

  private async runModelTrainingCycle(): Promise<void> {
    const minExamples = config.classifierMinExamplesPerCategory;
    const minCats = config.classifierMinCategoriesForModel;
    const allCategories = this.store.getAllCategories();
    const eligibleCategories = allCategories.filter(
      (c) => c.examplesCount >= minExamples
    );

    // Regra de validação discriminativa: exige pelo menos 2 categorias com >= 10 exemplos cada
    if (eligibleCategories.length < minCats) {
      return;
    }

    const eligibleKeys = eligibleCategories.map((c) => c.categoryKey);
    const candidateExamples = this.store.getExamplesByCategories(eligibleKeys);

    const activeModel = this.store.getActiveModel();
    const hasUnlearnedExamples = candidateExamples.some(
      (ex) => ex.status === 'stored'
    );
    const activeCatsChanged =
      !activeModel ||
      activeModel.categories.length !== eligibleKeys.length ||
      eligibleKeys.some((k) => !activeModel.categories.includes(k));

    if (!hasUnlearnedExamples && !activeCatsChanged) {
      return;
    }

    const samples: TrainingSampleInput[] = candidateExamples.map((ex) => ({
      id: ex.id,
      categoryKey: ex.categoryKey,
      displayName: ex.displayName,
      text: ex.normalizedText,
      textHash: ex.textHash,
    }));

    const trainingResult = await executeModelTraining(
      samples,
      config.classifierMinConfidence,
      config.classifierMinMargin
    );

    // Verifica quais categorias passaram no critério de qualidade individual (F1 >= classifierMinValidationF1)
    const minF1 = config.classifierMinValidationF1;
    const passingKeys = eligibleKeys.filter((catKey) => {
      const catReport = trainingResult.report.perCategory[catKey];
      return catReport && catReport.f1Score >= minF1;
    });

    const failingKeys = eligibleKeys.filter((k) => !passingKeys.includes(k));

    // Se alguma categoria falhou na validação (ex.: 10 exemplos incoerentes/contraditórios)
    if (failingKeys.length > 0) {
      for (const failKey of failingKeys) {
        const failCat = this.store.getCategory(failKey);
        const failMetrics = trainingResult.report.perCategory[failKey];
        const f1Val = failMetrics?.f1Score ?? 0;
        const failMsg = `A categoria "${failCat?.displayName ?? failKey}" atingiu ${failCat?.examplesCount ?? 0} exemplos, mas reprovou na validação de coerência (F1=${(f1Val * 100).toFixed(1)}%, mínimo exigido=${(minF1 * 100).toFixed(1)}%). A categoria permanece em "pending_validation" até receber exemplos consistentes.`;

        this.store.recordAuditEvent({
          trainingId: null,
          fileCabinetId: 'SYSTEM',
          documentId: 0,
          eventType: 'validation_failed',
          errorCode: 'CATEGORY_VALIDATION_FAILED',
          message: failMsg,
          details: {
            categoryKey: failKey,
            f1Score: f1Val,
            minimumRequiredF1: minF1,
          },
        });

        // Atualiza a mensagem dos jobs stored dessa categoria para informar que aguarda mais exemplos coerentes
        for (const job of this.store.getJobsByCategoryAndStatus(
          failKey,
          'stored'
        )) {
          this.store.updateTrainingJob(job.trainingId, {
            statusMessage: failMsg,
            completedAt: new Date().toISOString(),
          });
        }
      }

      // Se restarem menos de 2 categorias aprovadas, não ativamos um modelo de classe única
      if (passingKeys.length < minCats) {
        return;
      }

      // Se existem pelo menos 2 categorias válidas que passaram, re-treinamos apenas com as categorias aprovadas
      const filteredSamples = samples.filter((s) =>
        passingKeys.includes(s.categoryKey)
      );
      const retryResult = await executeModelTraining(
        filteredSamples,
        config.classifierMinConfidence,
        config.classifierMinMargin
      );

      if (retryResult.report.macroF1 < minF1) {
        return;
      }

      this.store.activateNewModelVersion({
        categories: passingKeys,
        report: retryResult.report,
        artifact: retryResult.artifact,
        incorporatedExampleIds: filteredSamples.map((s) => s.id),
      });
      return;
    }

    // Validação global de Macro-F1 e proteção contra regressão severa
    if (trainingResult.report.macroF1 < minF1) {
      return;
    }

    if (
      activeModel &&
      activeModel.categories.length === eligibleKeys.length &&
      eligibleKeys.every((k) => activeModel.categories.includes(k))
    ) {
      const f1Drop =
        activeModel.report.macroF1 - trainingResult.report.macroF1;
      if (f1Drop > config.classifierMaxRegressionDrop) {
        this.store.recordAuditEvent({
          trainingId: null,
          fileCabinetId: 'SYSTEM',
          documentId: 0,
          eventType: 'validation_failed',
          errorCode: 'MODEL_REGRESSION_PREVENTED',
          message: `Novo modelo rejeitado para evitar regressão (Macro-F1 caiu de ${activeModel.report.macroF1} para ${trainingResult.report.macroF1}). Versão ${activeModel.version} mantida ativa.`,
        });
        return;
      }
    }

    const activated = this.store.activateNewModelVersion({
      categories: eligibleKeys,
      report: trainingResult.report,
      artifact: trainingResult.artifact,
      incorporatedExampleIds: samples.map((s) => s.id),
    });

    this.store.recordAuditEvent({
      trainingId: null,
      fileCabinetId: 'SYSTEM',
      documentId: 0,
      eventType: 'model_activated',
      errorCode: null,
      message: `Modelo ${activated.version} validado e ativado com sucesso (${eligibleKeys.length} categorias ativas, precisão=${(activated.report.accuracy * 100).toFixed(1)}%, Macro-F1=${(activated.report.macroF1 * 100).toFixed(1)}%).`,
      details: {
        version: activated.version,
        categories: eligibleKeys,
        accuracy: activated.report.accuracy,
        macroF1: activated.report.macroF1,
        engine: activated.report.engine,
      },
    });
  }
}

let defaultServiceInstance: ClassifierService | null = null;

export function getDefaultClassifierService(): ClassifierService {
  if (!defaultServiceInstance) {
    defaultServiceInstance = new ClassifierService();
  }
  return defaultServiceInstance;
}

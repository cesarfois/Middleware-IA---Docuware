import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { TrainedModelArtifact } from './ml-engine.js';
import type {
  CategoryStatus,
  ModelValidationReport,
  TrainingJobStatus,
  TrainingOperationType,
} from './types.js';

export interface StoredCategoryRecord {
  categoryKey: string;
  displayName: string;
  status: CategoryStatus;
  examplesCount: number;
  activeModelVersion: string | null;
  lastValidationF1: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredExampleRecord {
  id: number;
  fileCabinetId: string;
  documentId: number;
  categoryKey: string;
  displayName: string;
  normalizedText: string;
  textHash: string;
  charCount: number;
  pageCount: number;
  status: 'stored' | 'learned';
  includedInModelVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTrainingJobRecord {
  trainingId: string;
  fileCabinetId: string;
  documentId: number;
  categoryKey: string;
  displayName: string;
  status: TrainingJobStatus;
  textshotRetrieved: boolean;
  exampleStored: boolean;
  includedInModel: boolean;
  isIdempotentDuplicate?: boolean;
  wasCorrection: boolean;
  previousDocumentType: string | null;
  operationType?: TrainingOperationType;
  attempts: number;
  modelVersion: string | null;
  validationAccuracy: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  statusMessage: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface StoredModelRecord {
  version: string;
  isActive: boolean;
  isPrevious: boolean;
  categories: string[];
  report: ModelValidationReport;
  artifact: TrainedModelArtifact;
  trainedAt?: string;
  activatedAt?: string;
  createdAt: string;
}

export interface StoredAuditEventRecord {
  id: number;
  trainingId: string | null;
  fileCabinetId: string;
  documentId: number;
  eventType:
    | 'job_error'
    | 'job_rejected'
    | 'label_correction'
    | 'validation_failed'
    | 'model_activated';
  errorCode: string | null;
  message: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

interface PersistedDatabaseSchema {
  counters: {
    jobSeq: number;
    exampleSeq: number;
    modelSeq: number;
    auditSeq: number;
  };
  categories: Record<string, StoredCategoryRecord>;
  examples: StoredExampleRecord[];
  jobs: Record<string, StoredTrainingJobRecord>;
  models: StoredModelRecord[];
  auditHistory: StoredAuditEventRecord[];
}

/**
 * Armazenamento persistente transacional e atómico em disco para o motor de classificação.
 * Garante que categorias, exemplos de documentos, trabalhos da fila assíncrona, histórico de erros
 * e versões de modelos treinados sobrevivam a reinícios do contentor ou da VPS.
 */
export class ClassifierStore {
  private readonly dataDir: string;
  private readonly stateFilePath: string;
  private state: PersistedDatabaseSchema;

  constructor(customDataDir?: string) {
    this.dataDir = customDataDir ?? config.classifierDataDir;
    this.stateFilePath = path.join(this.dataDir, 'classifier-state.json');
    this.ensureDirectory();
    this.state = this.loadFromDisk();
  }

  private ensureDirectory(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private createEmptyState(): PersistedDatabaseSchema {
    return {
      counters: {
        jobSeq: 0,
        exampleSeq: 0,
        modelSeq: 0,
        auditSeq: 0,
      },
      categories: {},
      examples: [],
      jobs: {},
      models: [],
      auditHistory: [],
    };
  }

  private loadFromDisk(): PersistedDatabaseSchema {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedDatabaseSchema>;
        if (parsed && typeof parsed === 'object') {
          return {
            counters: {
              jobSeq: parsed.counters?.jobSeq ?? 0,
              exampleSeq: parsed.counters?.exampleSeq ?? 0,
              modelSeq: parsed.counters?.modelSeq ?? 0,
              auditSeq: parsed.counters?.auditSeq ?? 0,
            },
            categories: parsed.categories ?? {},
            examples: Array.isArray(parsed.examples) ? parsed.examples : [],
            jobs: parsed.jobs ?? {},
            models: Array.isArray(parsed.models) ? parsed.models : [],
            auditHistory: Array.isArray(parsed.auditHistory)
              ? parsed.auditHistory
              : [],
          };
        }
      }
    } catch {
      // Se o ficheiro principal estiver corrompido, tenta recuperar do ficheiro de backup .bak
      const bakPath = `${this.stateFilePath}.bak`;
      try {
        if (fs.existsSync(bakPath)) {
          const rawBak = fs.readFileSync(bakPath, 'utf8');
          return JSON.parse(rawBak) as PersistedDatabaseSchema;
        }
      } catch {
        // Ignora e inicia limpo
      }
    }
    return this.createEmptyState();
  }

  /**
   * Grava o estado completo em disco de forma atómica (write to .tmp + rename).
   */
  public flush(): void {
    this.ensureDirectory();
    const tmpPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    const bakPath = `${this.stateFilePath}.bak`;
    const serialized = JSON.stringify(this.state, null, 2);

    fs.writeFileSync(tmpPath, serialized, 'utf8');
    if (fs.existsSync(this.stateFilePath)) {
      try {
        fs.copyFileSync(this.stateFilePath, bakPath);
      } catch {
        // Ignora erro de backup secundário
      }
    }
    fs.renameSync(tmpPath, this.stateFilePath);
  }

  /**
   * Recarrega o estado a partir do disco (útil em testes de recuperação pós-reinício).
   */
  public reloadFromDisk(): void {
    this.state = this.loadFromDisk();
  }

  /**
   * Limpa todos os dados (exclusivo para isolamento de testes automatizados).
   */
  public clearAllForTesting(): void {
    this.state = this.createEmptyState();
    this.flush();
  }

  /**
   * Garante que a categoria existe no registo e devolve o seu estado atual.
   */
  public ensureCategory(
    categoryKey: string,
    displayName: string
  ): StoredCategoryRecord {
    const now = new Date().toISOString();
    const existing = this.state.categories[categoryKey];
    if (existing) {
      return existing;
    }

    const created: StoredCategoryRecord = {
      categoryKey,
      displayName,
      status: 'pending_validation',
      examplesCount: 0,
      activeModelVersion: null,
      lastValidationF1: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.categories[categoryKey] = created;
    this.flush();
    return created;
  }

  public getCategory(categoryKey: string): StoredCategoryRecord | null {
    return this.state.categories[categoryKey] ?? null;
  }

  public getAllCategories(): StoredCategoryRecord[] {
    return Object.values(this.state.categories);
  }

  /**
   * Recalcula a contagem de exemplos válidos distintos por categoria.
   */
  public recalculateCategoryCounts(): void {
    const now = new Date().toISOString();
    const counts = new Map<string, number>();

    for (const ex of this.state.examples) {
      counts.set(ex.categoryKey, (counts.get(ex.categoryKey) ?? 0) + 1);
    }

    for (const cat of Object.values(this.state.categories)) {
      const newCount = counts.get(cat.categoryKey) ?? 0;
      cat.examplesCount = newCount;
      // Se uma categoria caiu abaixo do mínimo após uma correção supervisionada, volta a pending_validation
      if (newCount < config.classifierMinExamplesPerCategory && cat.status === 'active') {
        cat.status = 'pending_validation';
      }
      cat.updatedAt = now;
    }
  }

  /**
   * Cria um novo trabalho de treino na fila persistente (`status: "queued"`).
   */
  public createTrainingJob(params: {
    fileCabinetId: string;
    documentId: number;
    categoryKey: string;
    displayName: string;
  }): StoredTrainingJobRecord {
    this.ensureCategory(params.categoryKey, params.displayName);

    this.state.counters.jobSeq += 1;
    const seqStr = String(this.state.counters.jobSeq).padStart(6, '0');
    const trainingId = `trn-${seqStr}`;
    const now = new Date().toISOString();

    const job: StoredTrainingJobRecord = {
      trainingId,
      fileCabinetId: params.fileCabinetId,
      documentId: params.documentId,
      categoryKey: params.categoryKey,
      displayName: params.displayName,
      status: 'queued',
      textshotRetrieved: false,
      exampleStored: false,
      includedInModel: false,
      isIdempotentDuplicate: false,
      wasCorrection: false,
      previousDocumentType: null,
      operationType: 'pending',
      attempts: 0,
      modelVersion: null,
      validationAccuracy: null,
      errorCode: null,
      errorMessage: null,
      statusMessage: 'Exemplo recebido e colocado em fila para aprendizagem.',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.state.jobs[trainingId] = job;
    this.flush();
    return job;
  }

  public getTrainingJob(trainingId: string): StoredTrainingJobRecord | null {
    return this.state.jobs[trainingId] ?? null;
  }

  public getAllJobs(): StoredTrainingJobRecord[] {
    return Object.values(this.state.jobs);
  }

  public updateTrainingJob(
    trainingId: string,
    patch: Partial<Omit<StoredTrainingJobRecord, 'trainingId' | 'createdAt'>>
  ): StoredTrainingJobRecord | null {
    const job = this.state.jobs[trainingId];
    if (!job) return null;

    Object.assign(job, patch, {
      updatedAt: new Date().toISOString(),
    });
    this.flush();
    return job;
  }

  public getPendingOrInterruptedJobs(): StoredTrainingJobRecord[] {
    return Object.values(this.state.jobs)
      .filter((j) => j.status === 'queued' || j.status === 'processing')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public getJobsByCategoryAndStatus(
    categoryKey: string,
    status: TrainingJobStatus
  ): StoredTrainingJobRecord[] {
    return Object.values(this.state.jobs).filter(
      (j) => j.categoryKey === categoryKey && j.status === status
    );
  }

  /**
   * Recupera trabalhos que ficaram com `status: "processing"` devido a um reinício abrupto do processo.
   */
  public recoverInterruptedJobs(): number {
    let recovered = 0;
    const now = new Date().toISOString();
    for (const job of Object.values(this.state.jobs)) {
      if (job.status === 'processing') {
        job.status = 'queued';
        job.statusMessage =
          'Trabalho recuperado automaticamente após reinício do serviço e recolocado em fila.';
        job.updatedAt = now;
        recovered++;
      }
    }
    if (recovered > 0) {
      this.flush();
    }
    return recovered;
  }

  /**
   * Procura se o documento (`fileCabinetId + documentId`) já foi armazenado anteriormente.
   */
  public findExampleByDocument(
    fileCabinetId: string,
    documentId: number
  ): StoredExampleRecord | null {
    return (
      this.state.examples.find(
        (ex) =>
          ex.fileCabinetId === fileCabinetId && ex.documentId === documentId
      ) ?? null
    );
  }

  /**
   * Guarda ou atualiza um exemplo de documento (tratando duplicados idempotentes e correções supervisionadas).
   */
  public upsertExample(params: {
    fileCabinetId: string;
    documentId: number;
    categoryKey: string;
    displayName: string;
    normalizedText: string;
    textHash: string;
    charCount: number;
    pageCount: number;
    trainingId: string;
  }): {
    example: StoredExampleRecord;
    isDuplicateSameCategory: boolean;
    wasCorrection: boolean;
    previousCategoryKey: string | null;
    previousDisplayName: string | null;
  } {
    const now = new Date().toISOString();
    this.ensureCategory(params.categoryKey, params.displayName);

    const existing = this.findExampleByDocument(
      params.fileCabinetId,
      params.documentId
    );

    if (existing) {
      // Caso 1: Mesmo documento + mesma categoria -> idempotente (não inflaciona contagem)
      if (existing.categoryKey === params.categoryKey) {
        existing.normalizedText = params.normalizedText;
        existing.textHash = params.textHash;
        existing.charCount = params.charCount;
        existing.pageCount = params.pageCount;
        existing.updatedAt = now;
        this.recalculateCategoryCounts();
        this.flush();

        return {
          example: existing,
          isDuplicateSameCategory: true,
          wasCorrection: false,
          previousCategoryKey: null,
          previousDisplayName: null,
        };
      }

      // Caso 2: Mesmo documento + categoria diferente -> correção supervisionada de rótulo
      const prevCategoryKey = existing.categoryKey;
      const prevDisplayName = existing.displayName;

      existing.categoryKey = params.categoryKey;
      existing.displayName = params.displayName;
      existing.normalizedText = params.normalizedText;
      existing.textHash = params.textHash;
      existing.charCount = params.charCount;
      existing.pageCount = params.pageCount;
      existing.status = 'stored';
      existing.includedInModelVersion = null;
      existing.updatedAt = now;

      // Trabalhos anteriores do mesmo documento com a categoria antiga deixam de estar incluídos no modelo ativo
      for (const prevJob of Object.values(this.state.jobs)) {
        if (
          prevJob.trainingId !== params.trainingId &&
          prevJob.fileCabinetId === params.fileCabinetId &&
          prevJob.documentId === params.documentId &&
          prevJob.categoryKey === prevCategoryKey
        ) {
          prevJob.includedInModel = false;
          prevJob.updatedAt = now;
        }
      }

      this.recalculateCategoryCounts();
      this.recordAuditEvent({
        trainingId: params.trainingId,
        fileCabinetId: params.fileCabinetId,
        documentId: params.documentId,
        eventType: 'label_correction',
        errorCode: null,
        message: `Correção supervisionada de rótulo: "${prevDisplayName}" -> "${params.displayName}".`,
        details: {
          previousCategoryKey: prevCategoryKey,
          previousDisplayName: prevDisplayName,
          newCategoryKey: params.categoryKey,
          newDisplayName: params.displayName,
        },
      });
      this.flush();

      return {
        example: existing,
        isDuplicateSameCategory: false,
        wasCorrection: true,
        previousCategoryKey: prevCategoryKey,
        previousDisplayName: prevDisplayName,
      };
    }

    // Caso 3: Novo documento
    this.state.counters.exampleSeq += 1;
    const newExample: StoredExampleRecord = {
      id: this.state.counters.exampleSeq,
      fileCabinetId: params.fileCabinetId,
      documentId: params.documentId,
      categoryKey: params.categoryKey,
      displayName: params.displayName,
      normalizedText: params.normalizedText,
      textHash: params.textHash,
      charCount: params.charCount,
      pageCount: params.pageCount,
      status: 'stored',
      includedInModelVersion: null,
      createdAt: now,
      updatedAt: now,
    };

    this.state.examples.push(newExample);
    this.recalculateCategoryCounts();
    this.flush();

    return {
      example: newExample,
      isDuplicateSameCategory: false,
      wasCorrection: false,
      previousCategoryKey: null,
      previousDisplayName: null,
    };
  }

  public getExamplesByCategories(categoryKeys: string[]): StoredExampleRecord[] {
    const keySet = new Set(categoryKeys);
    return this.state.examples.filter((ex) => keySet.has(ex.categoryKey));
  }

  public getAllExamples(): StoredExampleRecord[] {
    return [...this.state.examples];
  }

  public getActiveModel(): StoredModelRecord | null {
    return this.state.models.find((m) => m.isActive) ?? null;
  }

  public getPreviousModel(): StoredModelRecord | null {
    return this.state.models.find((m) => m.isPrevious) ?? null;
  }

  /**
   * Ativa atomicamente uma nova versão do modelo validado, preservando a versão anterior
   * para rollback imediato e marcando todos os exemplos e trabalhos correspondentes como `learned`.
   */
  public activateNewModelVersion(params: {
    categories: string[];
    report: ModelValidationReport;
    artifact: TrainedModelArtifact;
    incorporatedExampleIds: number[];
  }): StoredModelRecord {
    const now = new Date().toISOString();
    this.state.counters.modelSeq += 1;
    const version = `v1.0.${this.state.counters.modelSeq}`;

    for (const m of this.state.models) {
      if (m.isActive) {
        m.isActive = false;
        m.isPrevious = true;
      } else {
        m.isPrevious = false;
      }
    }

    const newModel: StoredModelRecord = {
      version,
      isActive: true,
      isPrevious: false,
      categories: [...params.categories],
      report: params.report,
      artifact: params.artifact,
      trainedAt: params.artifact.trainedAt ?? now,
      activatedAt: now,
      createdAt: now,
    };

    this.state.models.push(newModel);

    // Mantém apenas as últimas 5 versões em disco para não crescer indefinidamente
    if (this.state.models.length > 5) {
      this.state.models = this.state.models.slice(-5);
    }

    const idSet = new Set(params.incorporatedExampleIds);
    const activeCatSet = new Set(params.categories);
    const incorporatedDocKeys = new Set<string>();

    for (const ex of this.state.examples) {
      if (idSet.has(ex.id) && activeCatSet.has(ex.categoryKey)) {
        ex.status = 'learned';
        ex.includedInModelVersion = version;
        ex.updatedAt = now;
        incorporatedDocKeys.add(
          `${ex.fileCabinetId}::${ex.documentId}::${ex.categoryKey}`
        );
      }
    }

    // Atualiza o estado das categorias incluídas no modelo
    for (const catKey of params.categories) {
      const cat = this.state.categories[catKey];
      if (cat) {
        cat.status = 'active';
        cat.activeModelVersion = version;
        cat.lastValidationF1 =
          params.report.perCategory[catKey]?.f1Score ?? params.report.macroF1;
        cat.updatedAt = now;
      }
    }

    // Atualiza todos os trabalhos que estavam em 'stored' (ou em processamento final) para os documentos incorporados
    for (const job of Object.values(this.state.jobs)) {
      const docKey = `${job.fileCabinetId}::${job.documentId}::${job.categoryKey}`;
      if (
        (job.status === 'stored' || job.status === 'processing' || job.status === 'learned') &&
        incorporatedDocKeys.has(docKey)
      ) {
        job.status = 'learned';
        job.includedInModel = true;
        job.modelVersion = version;
        job.validationAccuracy = params.report.accuracy;
        job.statusMessage = `Exemplo aprendido com sucesso e incorporado na versão ${version} do modelo (precisão de validação: ${(params.report.accuracy * 100).toFixed(1)}%).`;
        job.updatedAt = now;
        if (!job.completedAt) {
          job.completedAt = now;
        }
      }
    }

    this.flush();
    return newModel;
  }

  public recordAuditEvent(params: {
    trainingId: string | null;
    fileCabinetId: string;
    documentId: number;
    eventType: StoredAuditEventRecord['eventType'];
    errorCode: string | null;
    message: string;
    details?: Record<string, unknown>;
  }): StoredAuditEventRecord {
    this.state.counters.auditSeq += 1;
    const record: StoredAuditEventRecord = {
      id: this.state.counters.auditSeq,
      trainingId: params.trainingId,
      fileCabinetId: params.fileCabinetId,
      documentId: params.documentId,
      eventType: params.eventType,
      errorCode: params.errorCode,
      message: params.message,
      details: params.details,
      createdAt: new Date().toISOString(),
    };
    this.state.auditHistory.push(record);
    if (this.state.auditHistory.length > 500) {
      this.state.auditHistory = this.state.auditHistory.slice(-500);
    }
    this.flush();
    return record;
  }

  public getAuditHistory(): StoredAuditEventRecord[] {
    return [...this.state.auditHistory];
  }
}

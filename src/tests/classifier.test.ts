import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  ClassifierService,
  ClassifierValidationError,
  validateAndNormalizeClassifyRequest,
  validateAndNormalizeTrainRequest,
} from '../classifier-service.js';
import { ClassifierStore } from '../classifier-store.js';
import {
  DocuWarePlatformClient,
  DocuWareServiceError,
  truncateTextWordSafe,
  validateAndNormalizeTextshotRequest,
} from '../docuware-client.js';
import { parseRequestData } from '../schema-builder.js';
import type {
  NormalizedTextshotRequest,
  TextshotResponse,
} from '../types.js';

/**
 * Gerador determinístico de textos OCR realistas por categoria documental
 * para validar TF-IDF, Regressão Logística Multinomial, validação cruzada e calibração.
 */
function buildRealisticOcrText(kind: string, docId: number): string {
  switch (kind) {
    case 'ficha_intervencao':
      return [
        `FICHA DE INTERVENÇÃO TÉCNICA - REGISTO #${docId}`,
        `Ticket Nº: 813101-${docId} | Data da Intervenção: 02/10/2025`,
        `Técnico Responsável: Mateus Mizael | Agência RCS: Luanda`,
        `Equipamento: Terminal TPA Spectra T300 Wifi | Número de Série: SN-${docId}`,
        `Descrição da Avaria: Terminal bloqueado na bomba 3/4, substituição de fonte e manutenção preventiva.`,
        `Trabalho Resolvido: Sim | Peças Usadas: Cabo de alimentação AF-${docId}`,
        `Assinatura do Técnico e Carimbo do Cliente no local de assistência técnica.`,
      ].join('\n');

    case 'contrato':
      return [
        `CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE MANUTENÇÃO Nº CTR-${docId}/2026`,
        `Entre a Primeira Outorgante RCS Angola Lda e a Segunda Outorgante Cliente Empresarial S.A.`,
        `Cláusula Primeira (Objeto Contratual): O presente contrato tem por objeto a prestação de serviços continuados.`,
        `Cláusula Segunda (Prazo e Vigência): O contrato vigorará pelo prazo de 24 meses renováveis automaticamente.`,
        `Cláusula Terceira (Obrigações das Partes, Confidencialidade e Foro Jurídico de Luanda).`,
        `Assinado pelas partes contratantes em duplicado aos ${docId} dias do mês corrente.`,
      ].join('\n');

    case 'fatura':
      return [
        `FATURA COMERCIAL Nº FT 2026/${docId}`,
        `Data de Emissão: 10/10/2026 | Data de Vencimento: 09/11/2026 | NIF: 5401122334`,
        `Descrição dos Serviços Faturados: Licenciamento mensal e suporte técnico corporativo.`,
        `Base Tributável: 1.250.000,00 AOA | Imposto IVA (14%): 175.000,00 AOA`,
        `Valor Total a Pagar pelo Cliente: 1.425.000,00 AOA | Coordenadas Bancárias IBAN AO06.${docId}`,
      ].join('\n');

    case 'nota_credito':
      return [
        `NOTA DE CRÉDITO Nº NC 2026/${docId}`,
        `Documento de Retificação referente à Fatura Original FT 2026/${docId - 100}`,
        `Motivo da Anulação / Devolução: Estorno parcial por desconto comercial acordado e devolução de item.`,
        `Crédito a favor do cliente para abatimento em conta corrente: 250.000,00 AOA`,
        `Regularização de IVA a favor do adquirente conforme código fiscal em vigor.`,
      ].join('\n');

    case 'fatura_adiantamento':
      return [
        `FATURA DE ADIANTAMENTO Nº FA 2026/${docId}`,
        `Recebimento Antecipado / Sinal Inicial de 50% para início de execução do projeto #${docId}`,
        `Condição de Adiantamento: Pagamento prévio antes da entrega final dos equipamentos.`,
        `Valor do Adiantamento Recebido: 700.000,00 AOA | Saldo remanescente após entrega final.`,
        `Quitação de adiantamento financeiro contratual para mobilização de equipa.`,
      ].join('\n');

    case 'incoerente': {
      // Gera 10 textos completamente contraditórios entre si e com vocabulários 100% disjuntos para cada um dos 10 exemplos
      const vocabBuckets = [
        'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
        'sol lua estrelas galaxia nebulosa cometa orbita telescopio saturno jupiter',
        'futebol basquetebol voleibol natacao atletismo maratona campeonato golo arbitro',
        'culinaria receita forno farinha acucar chocolate baunilha sobremesa cozinhar',
        'geologia vulcao magma basalto granito tectonica sedimento fossil mineral',
        'arquitetura alvenaria betao viga pilar fundacao telhado fachada planta',
        'botanica clorofila fotossintese raiz caule folha polen semente orquidea',
        'musica sinfonia violino piano acorde melodia harmonia maestro partitura',
        'medicina cardiologia estetoscopio diagnostico bisturi clinica cirurgiao anatomia',
        'nautica navio bussola ancora proa popa estibordo bombordo marinheiro',
      ];
      const bucket = vocabBuckets[docId % vocabBuckets.length];
      return `${bucket} exclusivo_${docId} topico_${docId}`;
    }

    case 'ambiguo':
      return [
        `COMUNICADO INTERNO ADMINISTRATIVO #${docId}`,
        `Aviso geral da administração predial sobre atualização dos horários de receção e portaria.`,
        `Sem classificação documental financeira ou contratual associada neste registo.`,
      ].join('\n');

    default:
      return `Documento padrão #${docId} com texto suficiente para teste.`;
  }
}

describe('Sistema de Aprendizagem Supervisionada e Classificação Automática Local (/train, /train/status, /classify)', () => {
  let tmpDir: string;
  let store: ClassifierStore;
  let service: ClassifierService;

  // Mapa de documentos simulados no DocuWare (key: `${fileCabinetId}:${documentId}`)
  const mockDocuments = new Map<string, string | Error>();

  const mockDwClient = {
    retrieveDocumentTextshot: async (
      req: NormalizedTextshotRequest
    ): Promise<TextshotResponse> => {
      const key = `${req.fileCabinetId}:${req.documentId}`;
      const entry = mockDocuments.get(key);

      if (!entry) {
        throw new DocuWareServiceError(
          'DOCUMENT_NOT_FOUND',
          404,
          `Documento ${req.documentId} não encontrado no armário ${req.fileCabinetId}.`
        );
      }

      if (entry instanceof Error) {
        throw entry;
      }

      const maxChars = req.options.maxCharacters ?? 2000;
      const truncated = entry.length > maxChars;
      const text = truncated ? entry.slice(0, maxChars) : entry;

      return {
        success: true,
        documentId: req.documentId,
        fileCabinetId: req.fileCabinetId,
        source: 'docuware_textshot',
        sectionCount: 1,
        pageCount: 1,
        text,
        textLength: text.length,
        originalTextLength: entry.length,
        truncated,
        status: 'completed',
        processingTimeMs: 12,
        timings: {
          authTimeMs: 2,
          metadataTimeMs: 4,
          textshotTimeMs: 6,
          totalTimeMs: 12,
        },
        pages: req.options.includePages
          ? [
              {
                sectionId: 'sec-1',
                sectionIndex: 0,
                pageNumber: 1,
                globalPageNumber: 1,
                text,
                textLength: text.length,
                coordinatesAvailable: false,
              },
            ]
          : undefined,
      };
    },
  } as unknown as DocuWarePlatformClient;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-classifier-test-'));
    store = new ClassifierStore(tmpDir);
    service = new ClassifierService(store, mockDwClient);
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignora erro de limpeza no Windows
    }
  });

  it('Cenário 1 e 2: Deve enviar um único documento para /train, consultar /train/status e manter idempotência ao reenviar o mesmo documento com o mesmo tipo', async () => {
    store.clearAllForTesting();
    mockDocuments.clear();

    const cab = 'fc-glpi-001';
    mockDocuments.set(`${cab}:1001`, buildRealisticOcrText('ficha_intervencao', 1001));

    // 1. Envia documento único para treino
    const req1 = validateAndNormalizeTrainRequest({
      fileCabinetId: cab,
      documentId: 1001,
      documentType: 'Ficha de Intervenção',
    });
    const body1 = service.enqueueTrainingDocument(req1);

    assert.equal(body1.success, true);
    assert.equal(body1.status, 'queued');
    assert.ok(body1.trainingId.startsWith('trn-'));

    // Aguarda processamento assíncrono na fila
    await service.waitForIdle();

    // Consulta estado via getTrainingStatus
    const statusBody1 = service.getTrainingStatus(body1.trainingId);
    assert.equal(statusBody1.status, 'stored');
    assert.equal(statusBody1.jobFinished, true);
    assert.equal(statusBody1.category.status, 'pending_validation');
    assert.equal(statusBody1.category.examplesReceived, 1);
    assert.equal(statusBody1.category.minimumExamples, 10);
    assert.equal(statusBody1.category.minimumCategoriesForModel, 2);
    assert.equal(statusBody1.category.active, false);
    assert.equal(statusBody1.details.textshotRetrieved, true);
    assert.equal(statusBody1.details.exampleStored, true);
    assert.equal(statusBody1.details.includedInModel, false);
    assert.ok(statusBody1.details.completedAt !== null);

    // 2. Reenvia o MESMO documento (mesmo fileCabinetId + documentId) com o MESMO documentType (variação de maiúsculas)
    const req2 = validateAndNormalizeTrainRequest({
      fileCabinetId: cab,
      documentId: 1001,
      documentType: 'FICHA DE INTERVENÇÃO',
    });
    const body2 = service.enqueueTrainingDocument(req2);
    await service.waitForIdle();

    const statusBody2 = service.getTrainingStatus(body2.trainingId);

    // Confirma que não inflacionou a contagem de exemplos da categoria (continua 1)
    assert.equal(statusBody2.category.examplesReceived, 1);
    assert.equal(statusBody2.details.wasCorrection, false);
  });

  it('Cenário 3: Deve tratar o reenvio do mesmo documento com tipo diferente como correção supervisionada de rótulo', async () => {
    const cab = 'fc-glpi-001';
    const corrReq = validateAndNormalizeTrainRequest({
      fileCabinetId: cab,
      documentId: 1001,
      documentType: 'Relatório Técnico',
    });
    const corrJob = service.enqueueTrainingDocument(corrReq);
    await service.waitForIdle();

    const statusBody = service.getTrainingStatus(corrJob.trainingId);

    assert.equal(statusBody.details.wasCorrection, true);
    assert.equal(statusBody.details.previousDocumentType, 'Ficha de Intervenção');
    assert.equal(statusBody.category.examplesReceived, 1);
    assert.equal(store.getCategory('ficha_de_intervencao')?.examplesCount, 0);

    // Reverte para Ficha de Intervenção para continuar os próximos cenários
    const revertReq = validateAndNormalizeTrainRequest({
      fileCabinetId: cab,
      documentId: 1001,
      documentType: 'Ficha de Intervenção',
    });
    service.enqueueTrainingDocument(revertReq);
    await service.waitForIdle();
    assert.equal(store.getCategory('ficha_de_intervencao')?.examplesCount, 1);
  });

  it('Cenário 4, 5 e 7: Deve manter pending_validation de 1 a 9 exemplos (de múltiplos armários) e treinar/ativar automaticamente no 10.º exemplo', async () => {
    let lastTrainingId = '';
    for (let i = 2; i <= 9; i++) {
      const docId = 1000 + i;
      const cab = i % 2 === 0 ? 'fc-glpi-001' : 'fc-manut-002';
      mockDocuments.set(`${cab}:${docId}`, buildRealisticOcrText('ficha_intervencao', docId));

      const req = validateAndNormalizeTrainRequest({
        fileCabinetId: cab,
        documentId: docId,
        documentType: 'Ficha de Intervenção',
      });
      lastTrainingId = service.enqueueTrainingDocument(req).trainingId;
    }

    await service.waitForIdle();

    // No 9.º exemplo, a categoria DEVE continuar em pending_validation e o job em stored (não learned!)
    const status9 = service.getTrainingStatus(lastTrainingId);
    assert.equal(status9.status, 'stored');
    assert.equal(status9.category.status, 'pending_validation');
    assert.equal(status9.category.examplesReceived, 9);
    assert.equal(status9.category.active, false);

    // Envia agora o 10.º exemplo da 1.ª categoria ("Ficha de Intervenção")
    const cab10 = 'fc-manut-002';
    mockDocuments.set(`${cab10}:1010`, buildRealisticOcrText('ficha_intervencao', 1010));
    const req10 = validateAndNormalizeTrainRequest({
      fileCabinetId: cab10,
      documentId: 1010,
      documentType: 'Ficha de Intervenção',
    });
    const job10Id = service.enqueueTrainingDocument(req10).trainingId;

    await service.waitForIdle();

    // Com apenas 1 categoria elegível (1/2), o trabalho individual termina (jobFinished: true, status: 'stored')
    // sem ativar um modelo de classe única sem comparação real entre categorias!
    const status10SingleCat = service.getTrainingStatus(job10Id);
    assert.equal(status10SingleCat.status, 'stored');
    assert.equal(status10SingleCat.jobFinished, true);
    assert.equal(status10SingleCat.category.examplesReceived, 10);
    assert.equal(status10SingleCat.category.eligibleCategoriesCount, 1);
    assert.equal(status10SingleCat.category.minimumCategoriesForModel, 2);
    assert.equal(status10SingleCat.category.active, false);

    // Envia agora 10 exemplos da 2.ª categoria ("Contrato") para habilitar a comparação discriminativa real (>= 2 categorias)
    let jobContrato10Id = '';
    for (let i = 1; i <= 10; i++) {
      const docId = 2000 + i;
      const cab = 'fc-juridico';
      mockDocuments.set(`${cab}:${docId}`, buildRealisticOcrText('contrato', docId));
      const req = validateAndNormalizeTrainRequest({
        fileCabinetId: cab,
        documentId: docId,
        documentType: 'Contrato',
      });
      jobContrato10Id = service.enqueueTrainingDocument(req).trainingId;
    }

    await service.waitForIdle();

    // Confirma que ao atingir 2 categorias elegíveis (>= 10 exemplos cada), o treino e validação 5-fold
    // ativaram AMBAS as categorias ('Ficha de Intervenção' e 'Contrato') e transitaram os exemplos para 'learned'!
    const status10 = service.getTrainingStatus(job10Id);
    assert.equal(status10.status, 'learned');
    assert.equal(status10.jobFinished, true);
    assert.equal(status10.category.status, 'active');
    assert.equal(status10.category.examplesReceived, 10);
    assert.equal(status10.category.eligibleCategoriesCount, 2);
    assert.equal(status10.category.active, true);
    assert.equal(status10.details.includedInModel, true);
    assert.ok(status10.model.version?.startsWith('v1.0.'));
    assert.ok((status10.model.validationAccuracy ?? 0) >= 0.75);

    const statusContrato10 = service.getTrainingStatus(jobContrato10Id);
    assert.equal(statusContrato10.status, 'learned');
    assert.equal(statusContrato10.category.status, 'active');
  });

  it('Cenário 6: Deve manter uma categoria com 10 exemplos incoerentes em pending_validation sem ativá-la no modelo', async () => {
    const cab = 'fc-incoerente';
    let lastId = '';
    for (let i = 1; i <= 10; i++) {
      const docId = 9000 + i;
      mockDocuments.set(`${cab}:${docId}`, buildRealisticOcrText('incoerente', i));

      const req = validateAndNormalizeTrainRequest({
        fileCabinetId: cab,
        documentId: docId,
        documentType: 'Categoria Incoerente',
      });
      lastId = service.enqueueTrainingDocument(req).trainingId;
    }

    await service.waitForIdle();

    const statusBody = service.getTrainingStatus(lastId);

    // Como os 10 textos têm vocabulários 100% disjuntos entre si, o F1 da categoria é 0 (< 0.75)
    assert.equal(statusBody.category.examplesReceived, 10);
    assert.equal(statusBody.category.status, 'pending_validation');
    assert.equal(statusBody.category.active, false);
    assert.equal(statusBody.status, 'stored');

    // Remove os exemplos da categoria incoerente para os testes seguintes
    const stateRef = store as unknown as {
      state: {
        examples: Array<{ categoryKey: string }>;
        categories: Record<string, unknown>;
      };
    };
    stateRef.state.examples = stateRef.state.examples.filter(
      (e) => e.categoryKey !== 'categoria_incoerente'
    );
    delete stateRef.state.categories['categoria_incoerente'];
    store.flush();
  });

  it('Cenário 8, 9, 10 e 11: Deve treinar Fatura, Nota de Crédito e Fatura de Adiantamento e classificar corretamente num terceiro armário', async () => {
    const categoriesToTrain = [
      { type: 'Fatura', kind: 'fatura', baseId: 3000, cab: 'fc-financeiro-a' },
      {
        type: 'Nota de Crédito',
        kind: 'nota_credito',
        baseId: 4000,
        cab: 'fc-financeiro-b',
      },
      {
        type: 'Fatura de Adiantamento',
        kind: 'fatura_adiantamento',
        baseId: 5000,
        cab: 'fc-financeiro-a',
      },
    ];

    for (const cat of categoriesToTrain) {
      for (let i = 1; i <= 10; i++) {
        const docId = cat.baseId + i;
        mockDocuments.set(
          `${cat.cab}:${docId}`,
          buildRealisticOcrText(cat.kind, docId)
        );
        const req = validateAndNormalizeTrainRequest({
          fileCabinetId: cat.cab,
          documentId: docId,
          documentType: cat.type,
        });
        service.enqueueTrainingDocument(req);
      }
    }

    await service.waitForIdle();

    // Confirma que todas as 5 categorias estão ativas e separadas
    assert.equal(store.getCategory('ficha_de_intervencao')?.status, 'active');
    assert.equal(store.getCategory('contrato')?.status, 'active');
    assert.equal(store.getCategory('fatura')?.status, 'active');
    assert.equal(store.getCategory('nota_de_credito')?.status, 'active');
    assert.equal(store.getCategory('fatura_de_adiantamento')?.status, 'active');

    // Cenário 8 e 9: Classificar uma Ficha de Intervenção num TERCEIRO armário ('fc-armario-terceiro-999')
    const thirdCab = 'fc-armario-terceiro-999';
    mockDocuments.set(
      `${thirdCab}:8001`,
      buildRealisticOcrText('ficha_intervencao', 8001)
    );
    const clsFicha = await service.classifyDocument(
      validateAndNormalizeClassifyRequest({
        fileCabinetId: thirdCab,
        documentId: 8001,
      })
    );
    assert.equal(clsFicha.status, 'classified');
    assert.equal(clsFicha.classification.documentType, 'Ficha de Intervenção');
    assert.equal(clsFicha.classification.requiresManualReview, false);
    assert.ok(clsFicha.classification.confidence >= 0.7);

    // Cenário 10: Classificar um Contrato claro
    mockDocuments.set(
      `${thirdCab}:8002`,
      buildRealisticOcrText('contrato', 8002)
    );
    const clsContrato = await service.classifyDocument(
      validateAndNormalizeClassifyRequest({
        fileCabinetId: thirdCab,
        documentId: 8002,
      })
    );
    assert.equal(clsContrato.status, 'classified');
    assert.equal(clsContrato.classification.documentType, 'Contrato');
    assert.equal(clsContrato.classification.requiresManualReview, false);

    // Cenário 11: Distinguir entre "Fatura", "Nota de Crédito" e "Fatura de Adiantamento"
    mockDocuments.set(`${thirdCab}:8003`, buildRealisticOcrText('fatura', 8003));
    const clsFatura = await service.classifyDocument(
      validateAndNormalizeClassifyRequest({
        fileCabinetId: thirdCab,
        documentId: 8003,
      })
    );
    assert.equal(clsFatura.status, 'classified');
    assert.equal(clsFatura.classification.documentType, 'Fatura');

    mockDocuments.set(
      `${thirdCab}:8004`,
      buildRealisticOcrText('nota_credito', 8004)
    );
    const clsNC = await service.classifyDocument(
      validateAndNormalizeClassifyRequest({
        fileCabinetId: thirdCab,
        documentId: 8004,
      })
    );
    assert.equal(clsNC.status, 'classified');
    assert.equal(clsNC.classification.documentType, 'Nota de Crédito');

    mockDocuments.set(
      `${thirdCab}:8005`,
      buildRealisticOcrText('fatura_adiantamento', 8005)
    );
    const clsFA = await service.classifyDocument(
      validateAndNormalizeClassifyRequest({
        fileCabinetId: thirdCab,
        documentId: 8005,
      })
    );
    assert.equal(clsFA.status, 'classified');
    assert.equal(
      clsFA.classification.documentType,
      'Fatura de Adiantamento'
    );
  });

  it('Cenário 12: Deve devolver status "needs_review" (documentType: null, requiresManualReview: true) para documento ambíguo ou de categoria desconhecida', async () => {
    const cab = 'fc-armario-terceiro-999';
    mockDocuments.set(`${cab}:8099`, buildRealisticOcrText('ambiguo', 8099));

    const body = await service.classifyDocument(
      validateAndNormalizeClassifyRequest({
        fileCabinetId: cab,
        documentId: 8099,
      })
    );

    assert.equal(body.status, 'needs_review');
    assert.equal(body.classification.documentType, null);
    assert.equal(body.classification.requiresManualReview, true);

    // Testa também um documento de uma categoria ainda desconhecida pelo modelo (ex: Guia de Remessa Logística)
    // que compartilha algumas palavras isoladas ("Cliente", "Luanda", "Equipamento") com categorias conhecidas
    mockDocuments.set(
      `${cab}:8100`,
      'GUIA DE REMESSA E TRANSPORTE RODOVIÁRIO Nº GR-8100. Motorista: Carlos Mendes. Viatura Matrícula LD-44-22. Peso Bruto: 450kg. Local de Descarga: Armazém Central de Luanda. Mercadoria entregue ao Cliente em paletes seladas.'
    );
    const unknownCatBody = await service.classifyDocument(
      validateAndNormalizeClassifyRequest({
        fileCabinetId: cab,
        documentId: 8100,
      })
    );
    assert.equal(unknownCatBody.status, 'needs_review');
    assert.equal(unknownCatBody.classification.documentType, null);
    assert.equal(unknownCatBody.classification.requiresManualReview, true);
  });

  it('Cenário 13 e 14: Deve tratar documento sem Textshot disponível e documento inexistente no DocuWare', async () => {
    const cab = 'fc-erros-001';
    mockDocuments.set(
      `${cab}:7001`,
      new DocuWareServiceError(
        'TEXTSHOT_NOT_AVAILABLE',
        422,
        'O Textshot OCR ainda não está disponível para este documento no DocuWare.'
      )
    );

    // 13. Documento sem Textshot disponível
    await assert.rejects(
      () =>
        service.classifyDocument(
          validateAndNormalizeClassifyRequest({
            fileCabinetId: cab,
            documentId: 7001,
          })
        ),
      (err: unknown) =>
        err instanceof DocuWareServiceError &&
        err.code === 'TEXTSHOT_NOT_AVAILABLE' &&
        err.statusCode === 422
    );

    // 14. Documento inexistente no DocuWare
    await assert.rejects(
      () =>
        service.classifyDocument(
          validateAndNormalizeClassifyRequest({
            fileCabinetId: cab,
            documentId: 999999,
          })
        ),
      (err: unknown) =>
        err instanceof DocuWareServiceError &&
        err.code === 'DOCUMENT_NOT_FOUND' &&
        err.statusCode === 404
    );
  });

  it('Cenário 15: Deve recuperar trabalhos interrompidos após simulação de reinício do serviço e manter o modelo ativo em disco', async () => {
    const cab = 'fc-restart-001';
    mockDocuments.set(
      `${cab}:6001`,
      buildRealisticOcrText('ficha_intervencao', 6001)
    );

    // Cria um trabalho diretamente no disco como se o processo tivesse caído a meio ('processing')
    const interruptedJob = store.createTrainingJob({
      fileCabinetId: cab,
      documentId: 6001,
      categoryKey: 'ficha_de_intervencao',
      displayName: 'Ficha de Intervenção',
    });
    store.updateTrainingJob(interruptedJob.trainingId, {
      status: 'processing',
    });

    // Instancia um novo ClassifierStore e ClassifierService apontando para o MESMO diretório em disco
    const restartedStore = new ClassifierStore(tmpDir);
    const restartedService = new ClassifierService(
      restartedStore,
      mockDwClient
    );

    const recoveredCount = restartedService.recoverAndResumeQueue();
    assert.equal(recoveredCount, 1);

    await restartedService.waitForIdle();

    const statusAfterRestart = restartedService.getTrainingStatus(
      interruptedJob.trainingId
    );
    assert.equal(statusAfterRestart.status, 'learned');
    assert.equal(statusAfterRestart.details.textshotRetrieved, true);
  });

  it('Cenário 16: Deve confirmar que os contratos e funções de /textshot (excerto de 2000 caracteres) e /extract continuam operacionais', () => {
    // 1. Verifica validação e truncamento word-safe de 2000 caracteres do /textshot
    const tsReq = validateAndNormalizeTextshotRequest({
      fileCabinetId: 'fc-glpi-001',
      documentId: 7777,
      options: { maxCharacters: 2000 },
    });
    assert.equal(tsReq.options.maxCharacters, 2000);
    const truncated = truncateTextWordSafe('Palavra '.repeat(400), 2000);
    assert.equal(truncated.truncated, true);
    assert.ok(truncated.text.length <= 2000);

    // 2. Verifica parser do contrato dinâmico do /extract
    const extractParsed = parseRequestData(
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o',
        instructions: { prompt: 'Extraia o número do ticket.' },
        extraction: {
          fields: {
            N_Ticket: { type: 'string', description: 'Número do ticket' },
          },
        },
      })
    );
    assert.equal(extractParsed.provider, 'openai');
    assert.ok(extractParsed.requestedFieldNames.includes('N_Ticket'));

    // 3. Verifica validação de erros do classificador
    assert.throws(
      () => validateAndNormalizeTrainRequest({}),
      (err: unknown) =>
        err instanceof ClassifierValidationError &&
        err.code === 'INVALID_REQUEST'
    );
  });
});

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
import { preprocessOcrForMl } from '../ml-engine.js';
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
      // Nota: não acrescentar sufixos comuns (ex.: "exclusivo_X topico_X"), pois a normalização OCR remove "_"
      // e geraria tokens partilhados por todos os exemplos, tornando a categoria artificialmente coerente.
      const bucket = vocabBuckets[docId % vocabBuckets.length];
      return `${bucket} ${bucket}`;
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

    // Sincroniza a instância principal em memória com o estado gravado em disco pelo serviço reiniciado
    store.reloadFromDisk();
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

  it('Cenário 17: Deve consultar /train/summary e /train/history com métricas reais, filtros, paginação por cursor e distinção entre novo exemplo, duplicado idempotente e correção', async () => {
    const cab = 'fc-monitor-001';

    // 1. Adiciona 2 exemplos de uma nova categoria pendente ("Guia de Remessa" - apenas 2/10 exemplos)
    for (let i = 1; i <= 2; i++) {
      const docId = 9500 + i;
      mockDocuments.set(
        `${cab}:${docId}`,
        `GUIA DE REMESSA LOGÍSTICA Nº GR-${docId}. Transporte de mercadoria e equipamento técnico entregue em Luanda.`
      );
      service.enqueueTrainingDocument(
        validateAndNormalizeTrainRequest({
          fileCabinetId: cab,
          documentId: docId,
          documentType: 'Guia de Remessa',
        })
      );
    }

    // 2. Adiciona 1 documento com OCR insuficiente -> 'rejected'
    mockDocuments.set(`${cab}:9601`, 'ok');
    service.enqueueTrainingDocument(
      validateAndNormalizeTrainRequest({
        fileCabinetId: cab,
        documentId: 9601,
        documentType: 'Guia de Remessa',
      })
    );

    // 3. Adiciona 1 documento inexistente -> 'failed'
    service.enqueueTrainingDocument(
      validateAndNormalizeTrainRequest({
        fileCabinetId: cab,
        documentId: 9699,
        documentType: 'Guia de Remessa',
      })
    );

    await service.waitForIdle();

    // Consulta o resumo geral (/train/summary)
    const summaryRes = service.getTrainingSummary();
    assert.equal(summaryRes.success, true);
    assert.equal(summaryRes.model.status, 'active');
    assert.equal(summaryRes.model.engine, 'node_tfidf_logreg');
    assert.ok(summaryRes.model.version?.startsWith('v1.0.'));
    assert.ok(summaryRes.model.trainedAt);
    assert.ok(summaryRes.model.activatedAt);
    assert.ok(summaryRes.model.validation);
    assert.ok(summaryRes.model.validation.accuracy >= 0.75);
    assert.ok(summaryRes.model.validation.macroF1 >= 0.75);
    assert.ok(summaryRes.model.validation.weightedF1 >= 0.75);

    // 5 categorias ativas (Ficha de Intervenção, Contrato, Fatura, Nota de Crédito, Fatura de Adiantamento)
    // + 2 categorias pendentes (Relatório Técnico do Cenário 3 com 0 exemplos e Guia de Remessa com 2 exemplos)
    assert.equal(summaryRes.summary.activeCategories, 5);
    assert.equal(summaryRes.summary.pendingCategories, 2);
    assert.equal(summaryRes.summary.totalCategories, 7);
    assert.equal(summaryRes.summary.eligibleCategories, 5);
    assert.equal(summaryRes.summary.pendingExamples, 2);
    assert.equal(
      summaryRes.summary.totalExamples,
      summaryRes.summary.learnedExamples + summaryRes.summary.pendingExamples
    );
    assert.ok(summaryRes.summary.rejectedJobs >= 1);
    assert.ok(summaryRes.summary.failedJobs >= 1);

    const guiaCat = summaryRes.categories.find(
      (c) => c.documentType === 'Guia de Remessa'
    );
    assert.ok(guiaCat);
    assert.equal(guiaCat.status, 'pending_validation');
    assert.equal(guiaCat.examplesReceived, 2);
    assert.equal(guiaCat.examplesIncludedInModel, 0);
    assert.equal(guiaCat.pendingExamples, 2);
    assert.equal(guiaCat.active, false);
    assert.equal(guiaCat.validation, null);
    assert.equal(guiaCat.activation.eligible, false);
    assert.equal(guiaCat.activation.reasonCode, 'INSUFFICIENT_EXAMPLES');
    assert.ok(guiaCat.lastExampleAt);

    const fichaCat = summaryRes.categories.find(
      (c) => c.documentType === 'Ficha de Intervenção'
    );
    assert.ok(fichaCat);
    assert.equal(fichaCat.status, 'active');
    assert.equal(fichaCat.active, true);
    assert.ok(fichaCat.examplesIncludedInModel >= 10);
    assert.equal(fichaCat.pendingExamples, 0);
    assert.ok(fichaCat.validation);
    assert.ok(fichaCat.validation.f1 >= 0.75);
    assert.equal(fichaCat.activation.eligible, true);
    assert.equal(fichaCat.activation.lastAttemptStatus, 'approved');
    assert.equal(fichaCat.activation.reasonCode, 'VALIDATED_AND_ACTIVE');
    assert.ok(summaryRes.trainingDiagnostics.lastAttemptAt);
    assert.equal(summaryRes.trainingDiagnostics.activationApproved, true);

    // Consulta o histórico (/train/history) com paginação por cursor
    const page1 = service.getTrainingHistory({ limit: 5 });
    assert.equal(page1.success, true);
    assert.equal(page1.count, 5);
    assert.equal(page1.limit, 5);
    assert.equal(page1.hasMore, true);
    assert.ok(page1.nextCursor);

    const page2 = service.getTrainingHistory({
      limit: 5,
      cursor: page1.nextCursor!,
    });
    assert.equal(page2.count, 5);
    assert.notEqual(page1.items[0]!.trainingId, page2.items[0]!.trainingId);

    // Verifica que nenhum item contém texto OCR bruto
    const fullHistory = service.getTrainingHistory({ limit: 200 });
    for (const item of fullHistory.items) {
      assert.equal('normalizedText' in item, false);
      assert.equal('text' in item, false);
    }

    // Verifica distinção entre novo documento válido, duplicado idempotente, correção, rejeitado e falha
    const idempotentItem = fullHistory.items.find(
      (i) => i.trainingId === 'trn-000002'
    );
    assert.ok(idempotentItem);
    assert.equal(idempotentItem.isIdempotentDuplicate, true);
    assert.equal(idempotentItem.operationType, 'idempotent_duplicate');
    assert.equal(idempotentItem.wasCorrection, false);

    const correctionItem = fullHistory.items.find(
      (i) => i.trainingId === 'trn-000003'
    );
    assert.ok(correctionItem);
    assert.equal(correctionItem.wasCorrection, true);
    assert.equal(correctionItem.previousDocumentType, 'Ficha de Intervenção');
    assert.equal(correctionItem.operationType, 'label_correction');
    assert.equal(correctionItem.isIdempotentDuplicate, false);

    const newExampleItem = fullHistory.items.find(
      (i) => i.trainingId === 'trn-000001'
    );
    assert.ok(newExampleItem);
    assert.equal(newExampleItem.operationType, 'new_example');
    assert.equal(newExampleItem.isIdempotentDuplicate, false);
    assert.equal(newExampleItem.wasCorrection, false);

    // Testa filtros por status e documentType
    const rejectedHistory = service.getTrainingHistory({ status: 'rejected' });
    assert.ok(rejectedHistory.items.length >= 1);
    assert.ok(
      rejectedHistory.items.every(
        (i) => i.status === 'rejected' && i.operationType === 'rejected'
      )
    );

    const failedHistory = service.getTrainingHistory({ status: 'failed' });
    assert.ok(failedHistory.items.length >= 1);
    assert.ok(
      failedHistory.items.every(
        (i) => i.status === 'failed' && i.operationType === 'failed'
      )
    );

    const guiaHistory = service.getTrainingHistory({
      documentType: 'Guia de Remessa',
    });
    assert.equal(guiaHistory.totalMatching, 4);
  });

  it('Cenário 18: Deve validar e ativar todas as 4 categorias do cenário real de produção (62 exemplos: Factura=20, Factura Adiantamento=16, Factura Global=12, Ficha de Intervenção=14) com consistência matemática exata na matriz de confusão', async () => {
    const prodDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dw-classifier-prod62-')
    );
    try {
      const prodStore = new ClassifierStore(prodDir);
      const prodService = new ClassifierService(prodStore, mockDwClient);
      const cab = 'fc-prod-62';

      // 1. Factura (20 exemplos) - partilha rodapé fiscal comum com as outras faturas
      for (let i = 1; i <= 20; i++) {
        const docId = 10000 + i;
        mockDocuments.set(
          `${cab}:${docId}`,
          `FACTURA COMERCIAL Nº FT 2026/${docId}\nData de Emissão: 2026-10-${(i % 28) + 1}\nCliente: Sociedade Mineira de Catoca Lda - NIF 540112233${i}\n Artigo: Fornecimento de licenças de software e manutenção mensal ref ${i}.\nSubtotal líquido: ${i * 1500},00 Kz | IVA 14%: ${i * 210},00 Kz | Total a Pagar: ${i * 1710},00 Kz.\nProcessado por programa validado n.º 144/AGT/2024. Coordenadas Bancárias IBAN AO06.0040.0000.`
        );
        prodService.enqueueTrainingDocument(
          validateAndNormalizeTrainRequest({
            fileCabinetId: cab,
            documentId: docId,
            documentType: 'Factura',
          })
        );
      }

      // 2. Ficha de Intervenção (14 exemplos)
      for (let i = 1; i <= 14; i++) {
        const docId = 20000 + i;
        mockDocuments.set(
          `${cab}:${docId}`,
          `FICHA DE INTERVENÇÃO TÉCNICA Nº FIT-2026-${docId}\nTécnico Responsável: Eng. Mateus Silva | Equipamento: Servidor Bastidor #${i}\nDiagnóstico e trabalhos executados: Substituição de fonte de alimentação redundante, atualização de firmware e testes de carga concluídos sem anomalias.\nTempo de intervenção: ${i + 1} horas. Assinatura do cliente e carimbo de conformidade técnica.`
        );
        prodService.enqueueTrainingDocument(
          validateAndNormalizeTrainRequest({
            fileCabinetId: cab,
            documentId: docId,
            documentType: 'Ficha de Intervenção',
          })
        );
      }

      // 3. Factura Adiantamento (16 exemplos) - partilha vocabulário fiscal de fatura, mas com cabeçalho/termos de adiantamento
      for (let i = 1; i <= 16; i++) {
        const docId = 30000 + i;
        mockDocuments.set(
          `${cab}:${docId}`,
          `FACTURA ADIANTAMENTO Nº FA 2026/${docId}\nDocumento de Adiantamento / Sinal Antecipado (${30 + (i % 3) * 10}% do valor contratual)\nCliente: Sociedade Mineira de Catoca Lda - NIF 540112233${i}\nDescrição: Pagamento antecipado de caução inicial para adjudicação do projeto fase ${i}.\nSubtotal líquido: ${i * 2000},00 Kz | IVA 14%: ${i * 280},00 Kz | Total de Adiantamento: ${i * 2280},00 Kz.\nProcessado por programa validado n.º 144/AGT/2024. Coordenadas Bancárias IBAN AO06.0040.0000.`
        );
        prodService.enqueueTrainingDocument(
          validateAndNormalizeTrainRequest({
            fileCabinetId: cab,
            documentId: docId,
            documentType: 'Factura Adiantamento',
          })
        );
      }

      // 4. Factura Global (12 exemplos) - partilha vocabulário fiscal de fatura, mas com resumo global mensal de guias
      for (let i = 1; i <= 12; i++) {
        const docId = 40000 + i;
        mockDocuments.set(
          `${cab}:${docId}`,
          `FACTURA GLOBAL MENSAL Nº FG 2026/${docId}\nResumo Consolidado de Faturação Global do Período Mensal ${i}/2026\nCliente: Sociedade Mineira de Catoca Lda - NIF 540112233${i}\nAgrupamento consolidado das guias de remessa e consumos acumulados do mês n.º GR-${i}01 a GR-${i}25.\nSubtotal líquido: ${i * 9500},00 Kz | IVA 14%: ${i * 1330},00 Kz | Total Global Consolidado: ${i * 10830},00 Kz.\nProcessado por programa validado n.º 144/AGT/2024. Coordenadas Bancárias IBAN AO06.0040.0000.`
        );
        prodService.enqueueTrainingDocument(
          validateAndNormalizeTrainRequest({
            fileCabinetId: cab,
            documentId: docId,
            documentType: 'Factura Global',
          })
        );
      }

      await prodService.waitForIdle();

      const summary = prodService.getTrainingSummary();
      assert.equal(summary.model.status, 'active');
      assert.equal(summary.summary.totalCategories, 4);
      assert.equal(summary.summary.eligibleCategories, 4);
      assert.equal(summary.summary.activeCategories, 4);
      assert.equal(summary.summary.pendingCategories, 0);
      assert.equal(summary.summary.totalExamples, 62);
      assert.equal(summary.summary.learnedExamples, 62);
      assert.equal(summary.summary.pendingExamples, 0);

      // Verificação de consistência matemática estrita entre a Matriz de Confusão 4x4 e as métricas reportadas
      const diag = summary.trainingDiagnostics;
      assert.equal(diag.activationApproved, true);
      assert.equal(diag.candidateExamples, 62);
      assert.equal(diag.candidateCategories.length, 4);
      assert.equal(diag.rejectionReasons.length, 0);
      assert.ok(diag.candidateValidation);
      const candVal = diag.candidateValidation!;

      const cm = candVal.confusionMatrix;
      assert.equal(cm.labels.length, 4);
      assert.equal(cm.matrix.length, 4);

      const totalCmSum = cm.matrix.reduce(
        (acc, row) => acc + row.reduce((rAcc, v) => rAcc + v, 0),
        0
      );
      assert.equal(totalCmSum, 62);

      let diagSum = 0;
      let macroF1Sum = 0;
      let weightedF1Sum = 0;

      for (let c = 0; c < 4; c++) {
        const label = cm.labels[c]!;
        const catMetrics = candVal.perCategory[label];
        assert.ok(catMetrics, `Métricas ausentes para ${label}`);

        const tp = cm.matrix[c]![c]!;
        const rowSum = cm.matrix[c]!.reduce((a, b) => a + b, 0);
        let colSum = 0;
        for (let r = 0; r < 4; r++) {
          colSum += cm.matrix[r]![c]!;
        }

        const expectedPrecision = colSum > 0 ? Number((tp / colSum).toFixed(4)) : 0;
        const expectedRecall = rowSum > 0 ? Number((tp / rowSum).toFixed(4)) : 0;
        const rawP = colSum > 0 ? tp / colSum : 0;
        const rawR = rowSum > 0 ? tp / rowSum : 0;
        const expectedF1 =
          rawP + rawR > 0
            ? Number(((2 * rawP * rawR) / (rawP + rawR)).toFixed(4))
            : 0;

        assert.equal(catMetrics.support, rowSum);
        assert.equal(catMetrics.precision, expectedPrecision);
        assert.equal(catMetrics.recall, expectedRecall);
        assert.equal(catMetrics.f1, expectedF1);
        assert.ok(catMetrics.f1 >= 0.75);

        diagSum += tp;
        macroF1Sum += expectedF1;
        weightedF1Sum += expectedF1 * rowSum;
      }

      const expectedAccuracy = Number((diagSum / 62).toFixed(4));
      const expectedMacroF1 = Number((macroF1Sum / 4).toFixed(4));
      const expectedWeightedF1 = Number((weightedF1Sum / 62).toFixed(4));

      assert.equal(diag.candidateValidation.accuracy, expectedAccuracy);
      assert.equal(diag.candidateValidation.macroF1, expectedMacroF1);
      assert.equal(diag.candidateValidation.weightedF1, expectedWeightedF1);
      assert.equal(summary.model.validation?.accuracy, expectedAccuracy);
      assert.equal(summary.model.validation?.macroF1, expectedMacroF1);
      assert.equal(summary.model.validation?.weightedF1, expectedWeightedF1);

      for (const catItem of summary.categories) {
        assert.equal(catItem.status, 'active');
        assert.equal(catItem.active, true);
        assert.equal(
          catItem.examplesIncludedInModel,
          catItem.examplesReceived
        );
        assert.equal(catItem.pendingExamples, 0);
        assert.equal(catItem.activation.eligible, true);
        assert.equal(catItem.activation.includedInLastCandidate, true);
        assert.equal(catItem.activation.lastAttemptStatus, 'approved');
        assert.equal(catItem.activation.reasonCode, 'VALIDATED_AND_ACTIVE');
      }
    } finally {
      fs.rmSync(prodDir, { recursive: true, force: true });
    }
  });

  it('Cenário 19: Deve registar e persistir diagnóstico detalhado quando uma categoria elegível reprova por F1 insuficiente e recuperar em reinício quando corrigida', async () => {
    const diagDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dw-classifier-diag-')
    );
    try {
      const diagStore = new ClassifierStore(diagDir);
      const diagService = new ClassifierService(diagStore, mockDwClient);
      const cab = 'fc-diag-01';

      // 10 exemplos de Factura e 10 de Ficha de Intervenção -> modelo ativo v1.0.1
      for (let i = 1; i <= 10; i++) {
        mockDocuments.set(
          `${cab}:${50000 + i}`,
          `FACTURA COMERCIAL Nº FT-${i} emitida ao cliente com IVA 14%, subtotal líquido e IBAN bancário para pagamento.`
        );
        diagService.enqueueTrainingDocument(
          validateAndNormalizeTrainRequest({
            fileCabinetId: cab,
            documentId: 50000 + i,
            documentType: 'Factura',
          })
        );

        mockDocuments.set(
          `${cab}:${60000 + i}`,
          `FICHA DE INTERVENÇÃO TÉCNICA Nº FIT-${i} com relatório de manutenção preventiva de servidor, diagnóstico e assinatura do técnico.`
        );
        diagService.enqueueTrainingDocument(
          validateAndNormalizeTrainRequest({
            fileCabinetId: cab,
            documentId: 60000 + i,
            documentType: 'Ficha de Intervenção',
          })
        );
      }

      await diagService.waitForIdle();
      assert.equal(diagService.getTrainingSummary().model.version, 'v1.0.1');

      // Adiciona 10 exemplos contraditórios/ruído para "Categoria Incoerente" (copiando textos de Factura e Ficha de Intervenção)
      for (let i = 1; i <= 10; i++) {
        const docId = 70000 + i;
        const noisyText =
          i % 2 === 0
            ? `FACTURA COMERCIAL Nº FT-${i} emitida ao cliente com IVA 14%, subtotal líquido e IBAN bancário para pagamento.`
            : `FICHA DE INTERVENÇÃO TÉCNICA Nº FIT-${i} com relatório de manutenção preventiva de servidor, diagnóstico e assinatura do técnico.`;
        mockDocuments.set(`${cab}:${docId}`, noisyText);
        diagService.enqueueTrainingDocument(
          validateAndNormalizeTrainRequest({
            fileCabinetId: cab,
            documentId: docId,
            documentType: 'Categoria Incoerente',
          })
        );
      }

      await diagService.waitForIdle();

      // Verifica diagnóstico persistido após rejeição da 3ª categoria
      const reloadedStore = new ClassifierStore(diagDir);
      const reloadedService = new ClassifierService(reloadedStore, mockDwClient);
      const summaryAfterReject = reloadedService.getTrainingSummary();

      assert.equal(summaryAfterReject.model.version, 'v1.0.1');
      assert.equal(summaryAfterReject.summary.activeCategories, 2);
      assert.equal(summaryAfterReject.summary.pendingCategories, 1);
      assert.equal(
        summaryAfterReject.trainingDiagnostics.activationApproved,
        false
      );
      assert.ok(
        summaryAfterReject.trainingDiagnostics.rejectionReasons.length >= 1
      );
      assert.equal(
        summaryAfterReject.trainingDiagnostics.activeModelVersionBeforeAttempt,
        'v1.0.1'
      );
      assert.equal(
        summaryAfterReject.trainingDiagnostics.activeModelVersionAfterAttempt,
        'v1.0.1'
      );

      const badCat = summaryAfterReject.categories.find(
        (c) => c.documentType === 'Categoria Incoerente'
      );
      assert.ok(badCat);
      assert.equal(badCat.status, 'pending_validation');
      assert.equal(badCat.activation.eligible, true);
      assert.equal(badCat.activation.includedInLastCandidate, true);
      assert.equal(badCat.activation.lastAttemptStatus, 'rejected');
      assert.equal(
        badCat.activation.reasonCode,
        'CATEGORY_F1_BELOW_THRESHOLD'
      );
      assert.ok(badCat.activation.candidateF1 !== null);
      assert.ok(badCat.activation.candidateF1! < 0.75);
      assert.equal(badCat.activation.requiredF1, 0.75);
    } finally {
      fs.rmSync(diagDir, { recursive: true, force: true });
    }
  });

  it('Cenário 20: Deve reavaliar automaticamente no arranque (recoverAndResumeQueue) um estado legado com categorias elegíveis pendentes e métricas antigas sem perder os exemplos', async () => {
    const healDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'dw-classifier-heal-')
    );
    try {
      const store1 = new ClassifierStore(healDir);
      const cab = 'fc-heal-01';

      // Popula diretamente no store 2 categorias ativas e 1 categoria elegível stored simulando estado legado em disco
      for (let i = 1; i <= 10; i++) {
        const t1 = preprocessOcrForMl(
          `FACTURA COMERCIAL Nº FT-2026-${i} com valor líquido, IVA 14% e IBAN para liquidação financeira.`
        );
        store1.upsertExample({
          fileCabinetId: cab,
          documentId: 81000 + i,
          categoryKey: 'factura',
          displayName: 'Factura',
          normalizedText: t1.normalizedText,
          textHash: t1.textHash,
          charCount: t1.normalizedText.length,
          pageCount: 1,
          trainingId: `trn-h1-${i}`,
        });

        const t2 = preprocessOcrForMl(
          `FICHA DE INTERVENÇÃO TÉCNICA Nº FIT-2026-${i} referente a reparação de servidor, diagnóstico e substituição de peças.`
        );
        store1.upsertExample({
          fileCabinetId: cab,
          documentId: 82000 + i,
          categoryKey: 'ficha_de_intervencao',
          displayName: 'Ficha de Intervenção',
          normalizedText: t2.normalizedText,
          textHash: t2.textHash,
          charCount: t2.normalizedText.length,
          pageCount: 1,
          trainingId: `trn-h2-${i}`,
        });

        const t3 = preprocessOcrForMl(
          `FACTURA GLOBAL MENSAL Nº FG-2026-${i} consolidando as guias de remessa do período mensal e resumo de faturação.`
        );
        store1.upsertExample({
          fileCabinetId: cab,
          documentId: 83000 + i,
          categoryKey: 'factura_global',
          displayName: 'Factura Global',
          normalizedText: t3.normalizedText,
          textHash: t3.textHash,
          charCount: t3.normalizedText.length,
          pageCount: 1,
          trainingId: `trn-h3-${i}`,
        });
      }

      // Simula arranque do serviço sobre o diretório persistido
      const bootedStore = new ClassifierStore(healDir);
      const bootedService = new ClassifierService(bootedStore, mockDwClient);
      bootedService.recoverAndResumeQueue();
      await bootedService.waitForIdle();

      const healedSummary = bootedService.getTrainingSummary();
      assert.equal(healedSummary.model.status, 'active');
      assert.equal(healedSummary.summary.activeCategories, 3);
      assert.equal(healedSummary.summary.pendingCategories, 0);
      assert.equal(healedSummary.summary.learnedExamples, 30);
      assert.equal(healedSummary.summary.pendingExamples, 0);
      assert.equal(healedSummary.trainingDiagnostics.activationApproved, true);
    } finally {
      fs.rmSync(healDir, { recursive: true, force: true });
    }
  });
});

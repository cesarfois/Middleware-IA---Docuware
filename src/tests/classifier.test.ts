import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { ClassifierService } from '../classifier-service.js';
import { ClassifierStore } from '../classifier-store.js';
import { config } from '../config.js';
import {
  DocuWarePlatformClient,
  DocuWareServiceError,
} from '../docuware-client.js';
import { buildApp } from '../server.js';
import type {
  ClassifyResponse,
  NormalizedTextshotRequest,
  StandardErrorResponse,
  TextshotResponse,
  TrainImmediateResponse,
  TrainStatusResponse,
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
      // Gera 10 textos completamente contraditórios entre si e com vocabulários disjuntos a cada índice
      const vocabBuckets = [
        'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
        'sol lua estrelas galaxia nebulosa cometa orbita telescópio saturno jupiter',
        'futebol basquetebol voleibol natação atletismo maratona campeonato golo arbitro',
        'culinária receita forno farinha açucar chocolate baunilha sobremesa cozinhar',
        'geologia vulcão magma basalto granito tectónica sedimento fóssil mineral',
      ];
      const bucket = vocabBuckets[docId % vocabBuckets.length];
      return `${bucket} item_${docId % 5} registo_${docId % 5} texto_aleatorio_${docId % 5} ${bucket}`;
    }

    case 'ambiguo':
      return [
        `DOCUMENTO MISTO DE REFERÊNCIA #${docId}`,
        `Nota de conferência interna sem cabeçalho padrão definido.`,
        `Contém referência cruzada simultânea a Fatura Comercial FT 2026/${docId} com Base Tributável e IVA`,
        `e simultaneamente a Nota de Crédito NC 2026/${docId} de Retificação, Anulação, Devolução e Estorno parcial.`,
      ].join('\n');

    default:
      return `Documento padrão #${docId} com texto suficiente para teste.`;
  }
}

describe('Sistema de Aprendizagem Supervisionada e Classificação Automática Local (/train, /train/status, /classify)', () => {
  let tmpDir: string;
  let store: ClassifierStore;
  let service: ClassifierService;
  let app: FastifyInstance;
  if (!config.apiAuthToken) {
    config.apiAuthToken = 'test_docuware_token_2026';
  }
  const authToken = config.apiAuthToken;

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

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-classifier-test-'));
    store = new ClassifierStore(tmpDir);
    service = new ClassifierService(store, mockDwClient);
    app = await buildApp({
      docuWareClient: mockDwClient,
      classifierService: service,
    });
  });

  after(async () => {
    await app.close();
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

    // 1. Envia documento único para /ai-gateway/train
    const res1 = await app.inject({
      method: 'POST',
      url: '/ai-gateway/train',
      headers: { 'x-docuware-token': authToken },
      payload: {
        fileCabinetId: cab,
        documentId: 1001,
        documentType: 'Ficha de Intervenção',
      },
    });

    assert.equal(res1.statusCode, 200);
    const body1 = res1.json<TrainImmediateResponse>();
    assert.equal(body1.success, true);
    assert.equal(body1.status, 'queued');
    assert.ok(body1.trainingId.startsWith('trn-'));

    // Aguarda processamento assíncrono na fila
    await service.waitForIdle();

    // Consulta estado via GET /ai-gateway/train/status
    const statusRes1 = await app.inject({
      method: 'GET',
      url: `/ai-gateway/train/status?trainingId=${body1.trainingId}`,
      headers: { 'x-docuware-token': authToken },
    });

    assert.equal(statusRes1.statusCode, 200);
    const statusBody1 = statusRes1.json<TrainStatusResponse>();
    assert.equal(statusBody1.status, 'stored');
    assert.equal(statusBody1.category.status, 'pending_validation');
    assert.equal(statusBody1.category.examplesReceived, 1);
    assert.equal(statusBody1.category.minimumExamples, 10);
    assert.equal(statusBody1.category.active, false);
    assert.equal(statusBody1.details.textshotRetrieved, true);
    assert.equal(statusBody1.details.exampleStored, true);
    assert.equal(statusBody1.details.includedInModel, false);

    // 2. Reenvia o MESMO documento (mesmo fileCabinetId + documentId) com o MESMO documentType (variação de maiúsculas)
    const res2 = await app.inject({
      method: 'POST',
      url: '/ai-gateway/train',
      headers: { 'x-docuware-token': authToken },
      payload: {
        fileCabinetId: cab,
        documentId: 1001,
        documentType: 'FICHA DE INTERVENÇÃO',
      },
    });

    const body2 = res2.json<TrainImmediateResponse>();
    await service.waitForIdle();

    const statusRes2 = await app.inject({
      method: 'GET',
      url: `/ai-gateway/train/status?trainingId=${body2.trainingId}`,
      headers: { 'x-docuware-token': authToken },
    });
    const statusBody2 = statusRes2.json<TrainStatusResponse>();

    // Confirma que não inflacionou a contagem de exemplos da categoria (continua 1)
    assert.equal(statusBody2.category.examplesReceived, 1);
    assert.equal(statusBody2.details.wasCorrection, false);
  });

  it('Cenário 3: Deve tratar o reenvio do mesmo documento com tipo diferente como correção supervisionada de rótulo', async () => {
    const cab = 'fc-glpi-001';
    // O documento 1001 estava registado como "Ficha de Intervenção" (contagem = 1).
    // Vamos reenviá-lo corrigindo o rótulo para "Relatório Técnico" e depois voltar para "Ficha de Intervenção".
    const resCorr = await app.inject({
      method: 'POST',
      url: '/ai-gateway/train',
      headers: { 'x-docuware-token': authToken },
      payload: {
        fileCabinetId: cab,
        documentId: 1001,
        documentType: 'Relatório Técnico',
      },
    });

    const corrJob = resCorr.json<TrainImmediateResponse>();
    await service.waitForIdle();

    const statusRes = await app.inject({
      method: 'GET',
      url: `/ai-gateway/train/status?trainingId=${corrJob.trainingId}`,
      headers: { 'x-docuware-token': authToken },
    });
    const statusBody = statusRes.json<TrainStatusResponse>();

    assert.equal(statusBody.details.wasCorrection, true);
    assert.equal(statusBody.details.previousDocumentType, 'Ficha de Intervenção');
    assert.equal(statusBody.category.examplesReceived, 1);
    assert.equal(store.getCategory('ficha_de_intervencao')?.examplesCount, 0);

    // Reverte para Ficha de Intervenção para continuar os próximos cenários
    await app.inject({
      method: 'POST',
      url: '/ai-gateway/train',
      headers: { 'x-docuware-token': authToken },
      payload: {
        fileCabinetId: cab,
        documentId: 1001,
        documentType: 'Ficha de Intervenção',
      },
    });
    await service.waitForIdle();
    assert.equal(store.getCategory('ficha_de_intervencao')?.examplesCount, 1);
  });

  it('Cenário 4, 5 e 7: Deve manter pending_validation de 1 a 9 exemplos (de múltiplos armários) e treinar/ativar automaticamente no 10.º exemplo', async () => {
    // Já temos 1 exemplo (doc 1001 no armário fc-glpi-001).
    // Vamos enviar os exemplos 2 a 9 distribuídos entre dois armários diferentes (fc-glpi-001 e fc-manut-002).
    let lastTrainingId = '';
    for (let i = 2; i <= 9; i++) {
      const docId = 1000 + i;
      const cab = i % 2 === 0 ? 'fc-glpi-001' : 'fc-manut-002';
      mockDocuments.set(`${cab}:${docId}`, buildRealisticOcrText('ficha_intervencao', docId));

      const res = await app.inject({
        method: 'POST',
        url: '/ai-gateway/train',
        headers: { 'x-docuware-token': authToken },
        payload: {
          fileCabinetId: cab,
          documentId: docId,
          documentType: 'Ficha de Intervenção',
        },
      });
      lastTrainingId = res.json<TrainImmediateResponse>().trainingId;
    }

    await service.waitForIdle();

    // No 9.º exemplo, a categoria DEVE continuar em pending_validation e o job em stored (não learned!)
    const status9Res = await app.inject({
      method: 'GET',
      url: `/ai-gateway/train/status?trainingId=${lastTrainingId}`,
      headers: { 'x-docuware-token': authToken },
    });
    const status9 = status9Res.json<TrainStatusResponse>();
    assert.equal(status9.status, 'stored');
    assert.equal(status9.category.status, 'pending_validation');
    assert.equal(status9.category.examplesReceived, 9);
    assert.equal(status9.category.active, false);

    // Envia agora o 10.º exemplo da categoria "Ficha de Intervenção"
    const cab10 = 'fc-manut-002';
    mockDocuments.set(`${cab10}:1010`, buildRealisticOcrText('ficha_intervencao', 1010));
    const res10 = await app.inject({
      method: 'POST',
      url: '/ai-gateway/train',
      headers: { 'x-docuware-token': authToken },
      payload: {
        fileCabinetId: cab10,
        documentId: 1010,
        documentType: 'Ficha de Intervenção',
      },
    });
    const job10Id = res10.json<TrainImmediateResponse>().trainingId;

    await service.waitForIdle();

    // Confirma que o 10.º exemplo disparou o treino automático, validou o modelo e passou a 'learned' e 'active'
    const status10Res = await app.inject({
      method: 'GET',
      url: `/ai-gateway/train/status?trainingId=${job10Id}`,
      headers: { 'x-docuware-token': authToken },
    });
    const status10 = status10Res.json<TrainStatusResponse>();
    assert.equal(status10.status, 'learned');
    assert.equal(status10.category.status, 'active');
    assert.equal(status10.category.examplesReceived, 10);
    assert.equal(status10.category.active, true);
    assert.equal(status10.details.includedInModel, true);
    assert.ok(status10.model.version?.startsWith('v1.0.'));
    assert.ok((status10.model.validationAccuracy ?? 0) >= 0.75);
  });

  it('Cenário 6: Deve manter uma categoria com 10 exemplos incoerentes em pending_validation sem ativá-la no modelo', async () => {
    const cab = 'fc-incoerente';
    let lastId = '';
    for (let i = 1; i <= 10; i++) {
      const docId = 9000 + i;
      mockDocuments.set(`${cab}:${docId}`, buildRealisticOcrText('incoerente', i));

      const res = await app.inject({
        method: 'POST',
        url: '/ai-gateway/train',
        headers: { 'x-docuware-token': authToken },
        payload: {
          fileCabinetId: cab,
          documentId: docId,
          documentType: 'Categoria Incoerente',
        },
      });
      lastId = res.json<TrainImmediateResponse>().trainingId;
    }

    await service.waitForIdle();

    const statusRes = await app.inject({
      method: 'GET',
      url: `/ai-gateway/train/status?trainingId=${lastId}`,
      headers: { 'x-docuware-token': authToken },
    });
    const statusBody = statusRes.json<TrainStatusResponse>();

    // Como os 10 textos são contraditórios em 5 grupos disjuntos, o F1 da categoria é baixo (< 0.75)
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

  it('Cenário 8, 9, 10 e 11: Deve treinar Contrato, Fatura, Nota de Crédito e Fatura de Adiantamento e classificar corretamente num terceiro armário', async () => {
    const categoriesToTrain = [
      { type: 'Contrato', kind: 'contrato', baseId: 2000, cab: 'fc-juridico' },
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
        await app.inject({
          method: 'POST',
          url: '/ai-gateway/train',
          headers: { 'x-docuware-token': authToken },
          payload: {
            fileCabinetId: cat.cab,
            documentId: docId,
            documentType: cat.type,
          },
        });
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
    const clsFichaRes = await app.inject({
      method: 'POST',
      url: '/ai-gateway/classify',
      headers: { 'x-docuware-token': authToken },
      payload: { fileCabinetId: thirdCab, documentId: 8001 },
    });
    assert.equal(clsFichaRes.statusCode, 200);
    const clsFicha = clsFichaRes.json<ClassifyResponse>();
    assert.equal(clsFicha.status, 'classified');
    assert.equal(clsFicha.classification.documentType, 'Ficha de Intervenção');
    assert.equal(clsFicha.classification.requiresManualReview, false);
    assert.ok(clsFicha.classification.confidence >= 0.7);

    // Cenário 10: Classificar um Contrato claro
    mockDocuments.set(
      `${thirdCab}:8002`,
      buildRealisticOcrText('contrato', 8002)
    );
    const clsContratoRes = await app.inject({
      method: 'POST',
      url: '/ai-gateway/classify',
      headers: { 'x-docuware-token': authToken },
      payload: { fileCabinetId: thirdCab, documentId: 8002 },
    });
    const clsContrato = clsContratoRes.json<ClassifyResponse>();
    assert.equal(clsContrato.status, 'classified');
    assert.equal(clsContrato.classification.documentType, 'Contrato');
    assert.equal(clsContrato.classification.requiresManualReview, false);

    // Cenário 11: Distinguir entre "Fatura", "Nota de Crédito" e "Fatura de Adiantamento"
    mockDocuments.set(`${thirdCab}:8003`, buildRealisticOcrText('fatura', 8003));
    const clsFatura = (
      await app.inject({
        method: 'POST',
        url: '/ai-gateway/classify',
        headers: { 'x-docuware-token': authToken },
        payload: { fileCabinetId: thirdCab, documentId: 8003 },
      })
    ).json<ClassifyResponse>();
    assert.equal(clsFatura.status, 'classified');
    assert.equal(clsFatura.classification.documentType, 'Fatura');

    mockDocuments.set(
      `${thirdCab}:8004`,
      buildRealisticOcrText('nota_credito', 8004)
    );
    const clsNC = (
      await app.inject({
        method: 'POST',
        url: '/ai-gateway/classify',
        headers: { 'x-docuware-token': authToken },
        payload: { fileCabinetId: thirdCab, documentId: 8004 },
      })
    ).json<ClassifyResponse>();
    assert.equal(clsNC.status, 'classified');
    assert.equal(clsNC.classification.documentType, 'Nota de Crédito');

    mockDocuments.set(
      `${thirdCab}:8005`,
      buildRealisticOcrText('fatura_adiantamento', 8005)
    );
    const clsFA = (
      await app.inject({
        method: 'POST',
        url: '/ai-gateway/classify',
        headers: { 'x-docuware-token': authToken },
        payload: { fileCabinetId: thirdCab, documentId: 8005 },
      })
    ).json<ClassifyResponse>();
    assert.equal(clsFA.status, 'classified');
    assert.equal(
      clsFA.classification.documentType,
      'Fatura de Adiantamento'
    );
  });

  it('Cenário 12: Deve devolver status "needs_review" (documentType: null, requiresManualReview: true) para documento ambíguo ou fora de domínio', async () => {
    const cab = 'fc-armario-terceiro-999';
    mockDocuments.set(`${cab}:8099`, buildRealisticOcrText('ambiguo', 8099));

    const res = await app.inject({
      method: 'POST',
      url: '/ai-gateway/classify',
      headers: { 'x-docuware-token': authToken },
      payload: { fileCabinetId: cab, documentId: 8099 },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<ClassifyResponse>();
    assert.equal(body.status, 'needs_review');
    assert.equal(body.classification.documentType, null);
    assert.equal(body.classification.requiresManualReview, true);
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
    const resNoTextshot = await app.inject({
      method: 'POST',
      url: '/ai-gateway/classify',
      headers: { 'x-docuware-token': authToken },
      payload: { fileCabinetId: cab, documentId: 7001 },
    });
    assert.equal(resNoTextshot.statusCode, 422);
    assert.equal(
      resNoTextshot.json<StandardErrorResponse>().code,
      'TEXTSHOT_NOT_AVAILABLE'
    );

    // 14. Documento inexistente no DocuWare (não está no mapa mockDocuments)
    const resNotFound = await app.inject({
      method: 'POST',
      url: '/ai-gateway/classify',
      headers: { 'x-docuware-token': authToken },
      payload: { fileCabinetId: cab, documentId: 999999 },
    });
    assert.equal(resNotFound.statusCode, 404);
    assert.equal(
      resNotFound.json<StandardErrorResponse>().code,
      'DOCUMENT_NOT_FOUND'
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

  it('Cenário 16: Deve confirmar que os endpoints /ai-gateway/textshot, /ai-gateway/extract e /ai-gateway/health continuam operacionais', async () => {
    const cab = 'fc-glpi-001';
    // 1. Verifica /ai-gateway/health
    const healthRes = await app.inject({
      method: 'GET',
      url: '/ai-gateway/health',
    });
    assert.equal(healthRes.statusCode, 200);

    // 2. Verifica /ai-gateway/textshot (incluindo o limite independente de 2000 caracteres por defeito)
    const longText = 'A'.repeat(3500);
    mockDocuments.set(`${cab}:7777`, longText);
    const tsRes = await app.inject({
      method: 'POST',
      url: '/ai-gateway/textshot',
      headers: { 'x-docuware-token': authToken },
      payload: {
        fileCabinetId: cab,
        documentId: 7777,
      },
    });
    assert.equal(tsRes.statusCode, 200);
    const tsBody = tsRes.json<TextshotResponse>();
    assert.equal(tsBody.success, true);
    assert.equal(tsBody.textLength, 2000);
    assert.equal(tsBody.originalTextLength, 3500);
    assert.equal(tsBody.truncated, true);

    // 3. Verifica que a rota /ai-gateway/extract continua ativa e protegida
    const extRes = await app.inject({
      method: 'POST',
      url: '/ai-gateway/extract',
      headers: { 'x-docuware-token': authToken },
    });
    // Sem multipart/form-data retorna 400 INVALID_MULTIPART (confirmando rota operacional)
    assert.equal(extRes.statusCode, 400);
    assert.equal(extRes.json<StandardErrorResponse>().code, 'INVALID_MULTIPART');
  });
});

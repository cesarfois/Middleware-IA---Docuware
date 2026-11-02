import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RequestValidationError,
  parseRequestData,
  buildOpenAIResponseFormat,
  buildSystemMessage,
  buildUserMessage,
  validateAndFilterResponse,
} from '../schema-builder.js';
import { isValidPdfBuffer } from '../routes/extract.js';
import { extractTokenFromHeaders } from '../auth.js';

describe('Contrato Canônico v2 (100% Orientado pelo JSON)', () => {
  it('deve processar o contrato canônico completo (provider, model, processing, instructions, extraction, response)', () => {
    const raw = JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o',
      processing: {
        strategy: 'native_pdf',
        temperature: 0,
        max_output_tokens: 1024,
      },
      instructions: {
        system: 'Instrução de sistema definida externamente no workflow.',
        prompt: 'Extraia exatamente os campos definidos em extraction.fields.',
        rules: [
          'Datas devem estar em dd/MM/yyyy',
          'Valores ausentes devem ser vazios',
        ],
      },
      extraction: {
        fields: {
          Campo_A: {
            type: 'string',
            description: 'Primeiro campo customizado',
          },
          Campo_B: {
            type: 'number',
            description: 'Segundo campo numérico',
          },
        },
      },
      response: {
        strict: true,
        null_handling: 'type_default',
      },
    });

    const parsed = parseRequestData(raw);
    assert.equal(parsed.contractVersion, 'v2');
    assert.equal(parsed.provider, 'openai');
    assert.equal(parsed.model, 'gpt-4o');
    assert.deepEqual(parsed.requestedFieldNames, ['Campo_A', 'Campo_B']);
    assert.ok(
      buildSystemMessage(parsed).startsWith(
        'Instrução de sistema definida externamente no workflow.'
      )
    );
    assert.ok(
      buildUserMessage(parsed).includes(
        'Extraia exatamente os campos definidos em extraction.fields.'
      )
    );
    assert.ok(
      buildUserMessage(parsed).includes('1. Datas devem estar em dd/MM/yyyy')
    );
  });

  it('deve rejeitar requestData vazio, texto plano ou sem campos de extração (sem fallback silencioso)', () => {
    assert.throws(
      () => parseRequestData(''),
      (err: unknown) => err instanceof RequestValidationError
    );

    assert.throws(
      () => parseRequestData('Extraia os dados deste PDF em texto livre'),
      (err: unknown) => err instanceof RequestValidationError
    );

    assert.throws(
      () =>
        parseRequestData(
          JSON.stringify({
            instructions: { prompt: 'Extraia algo' },
            extraction: { fields: {} },
          })
        ),
      (err: unknown) => err instanceof RequestValidationError
    );
  });

  it('deve suportar o adaptador explícito para o formato legado (system_instruction, prompt, schema) e rejeitar mistura de contratos', () => {
    const legacyPayload = JSON.stringify({
      system_instruction: 'Contexto legado',
      prompt: 'Prompt legado',
      schema: {
        Propriedade_1: 'Descrição 1',
      },
    });

    const adapted = parseRequestData(legacyPayload);
    assert.equal(adapted.contractVersion, 'legacy_v1');
    assert.deepEqual(adapted.requestedFieldNames, ['Propriedade_1']);

    // Mistura dos dois contratos deve falhar
    assert.throws(
      () =>
        parseRequestData(
          JSON.stringify({
            prompt: 'Prompt legado',
            schema: { A: '1' },
            extraction: { fields: { B: '2' } },
          })
        ),
      (err: unknown) => err instanceof RequestValidationError
    );
  });
});

describe('Teste de Aceitação Obrigatório (3 Execuções Dinâmicas sobre o mesmo Documento)', () => {
  // Simula uma resposta bruta do modelo contendo dados extras do documento para garantir filtragem estrita
  const simulatedRawModelOutput = {
    Cliente: 'Empresa Exemplo Lda',
    Telefone: '+351 210 000 000',
    N_Ticket: '98451',
    Tecnico: 'Carlos Mendes',
    Numero_Serie: 'SN-2026-X99',
    Campo_A: 'Valor A',
    Campo_B: 'Valor B',
    Campo_C: 'Valor C',
    Campo_Intruso_Nao_Solicitado: 'Não deve aparecer nunca',
  };

  it('1ª Execução: deve retornar EXCLUSIVAMENTE Cliente e Telefone', () => {
    const req1 = parseRequestData(
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o',
        instructions: {
          prompt: 'Extraia o nome do cliente e o telefone de contato.',
        },
        extraction: {
          fields: {
            Cliente: { type: 'string', description: 'Nome do cliente' },
            Telefone: { type: 'string', description: 'Telefone de contato' },
          },
        },
      })
    );

    const responseFormat = buildOpenAIResponseFormat(req1.fieldsMap);
    assert.deepEqual(responseFormat.json_schema.schema.required, [
      'Cliente',
      'Telefone',
    ]);

    const output1 = validateAndFilterResponse(simulatedRawModelOutput, req1);
    assert.deepEqual(Object.keys(output1), ['Cliente', 'Telefone']);
    assert.deepEqual(output1, {
      Cliente: 'Empresa Exemplo Lda',
      Telefone: '+351 210 000 000',
    });
  });

  it('2ª Execução: deve retornar EXCLUSIVAMENTE N_Ticket, Tecnico e Numero_Serie', () => {
    const req2 = parseRequestData(
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o',
        instructions: {
          prompt:
            'Extraia o número do ticket, o nome do técnico e o número de série.',
        },
        extraction: {
          fields: {
            N_Ticket: { type: 'string', description: 'Número identificador' },
            Tecnico: { type: 'string', description: 'Técnico responsável' },
            Numero_Serie: {
              type: 'string',
              description: 'Número de série do equipamento',
            },
          },
        },
      })
    );

    const responseFormat = buildOpenAIResponseFormat(req2.fieldsMap);
    assert.deepEqual(responseFormat.json_schema.schema.required, [
      'N_Ticket',
      'Tecnico',
      'Numero_Serie',
    ]);

    const output2 = validateAndFilterResponse(simulatedRawModelOutput, req2);
    assert.deepEqual(Object.keys(output2), [
      'N_Ticket',
      'Tecnico',
      'Numero_Serie',
    ]);
    assert.deepEqual(output2, {
      N_Ticket: '98451',
      Tecnico: 'Carlos Mendes',
      Numero_Serie: 'SN-2026-X99',
    });
  });

  it('3ª Execução: deve retornar EXCLUSIVAMENTE Campo_A, Campo_B e Campo_C', () => {
    const req3 = parseRequestData(
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o',
        instructions: {
          prompt: 'Extraia os três valores nas propriedades personalizadas.',
        },
        extraction: {
          fields: {
            Campo_A: { type: 'string', description: 'Primeira informação' },
            Campo_B: { type: 'string', description: 'Segunda informação' },
            Campo_C: { type: 'string', description: 'Terceira informação' },
          },
        },
      })
    );

    const responseFormat = buildOpenAIResponseFormat(req3.fieldsMap);
    assert.deepEqual(responseFormat.json_schema.schema.required, [
      'Campo_A',
      'Campo_B',
      'Campo_C',
    ]);

    const output3 = validateAndFilterResponse(simulatedRawModelOutput, req3);
    assert.deepEqual(Object.keys(output3), ['Campo_A', 'Campo_B', 'Campo_C']);
    assert.deepEqual(output3, {
      Campo_A: 'Valor A',
      Campo_B: 'Valor B',
      Campo_C: 'Valor C',
    });
  });
});

describe('Validação de PDF e Autenticação', () => {
  it('deve validar magic bytes %PDF-', () => {
    const validPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj', 'latin1');
    const invalidFile = Buffer.from('Hello World not a PDF', 'utf8');

    assert.equal(isValidPdfBuffer(validPdf), true);
    assert.equal(isValidPdfBuffer(invalidFile), false);
  });

  it('deve extrair token tanto de X-DocuWare-Token quanto de Authorization: Bearer', () => {
    assert.equal(
      extractTokenFromHeaders({ 'x-docuware-token': 'meu-token-123' }),
      'meu-token-123'
    );
    assert.equal(
      extractTokenFromHeaders({ authorization: 'Bearer meu-token-456' }),
      'meu-token-456'
    );
    assert.equal(extractTokenFromHeaders({}), null);
  });
});

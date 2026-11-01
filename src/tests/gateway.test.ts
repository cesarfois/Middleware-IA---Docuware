import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRequestData,
  buildOpenAIResponseFormat,
  enforceNonNullSchemaDefaults,
} from '../schema-builder.js';
import { isValidPdfBuffer } from '../routes/extract.js';
import { extractTokenFromHeaders } from '../auth.js';

describe('Schema Builder & RequestData Parser', () => {
  it('deve construir json_schema com strict: true quando schema for fornecido', () => {
    const raw = JSON.stringify({
      system_instruction: 'Auditor de contratos',
      prompt: 'Extraia partes e valor',
      schema: {
        Contratante: 'Razão social da contratante',
        Contratada: 'Razão social da contratada',
        Valor_Total: 'Valor numérico',
      },
    });

    const parsed = parseRequestData(raw);
    assert.equal(parsed.mode, 'json_schema');
    assert.ok(parsed.schemaDefinition);

    const responseFormat = buildOpenAIResponseFormat(parsed.schemaDefinition);
    assert.equal(responseFormat.type, 'json_schema');
    if (responseFormat.type === 'json_schema') {
      assert.equal(responseFormat.json_schema.strict, true);
      assert.deepEqual(responseFormat.json_schema.schema.required, [
        'Contratante',
        'Contratada',
        'Valor_Total',
      ]);
      assert.equal(responseFormat.json_schema.schema.additionalProperties, false);
    }
  });

  it('deve interpretar texto plano simples em requestData como prompt em modo json_object', () => {
    const parsed = parseRequestData('Extraia o nome do fornecedor, CNPJ e valor total da nota.');
    assert.equal(parsed.mode, 'json_object');
    assert.equal(parsed.schemaDefinition, null);
    assert.equal(
      parsed.userPrompt,
      'Extraia o nome do fornecedor, CNPJ e valor total da nota.'
    );
  });

  it('deve garantir string vazia "" para campos omitidos ou nulos', () => {
    const schema = {
      Contratante: 'Nome',
      Foro: 'Cidade',
      Itens: [{ Descricao: 'Item' }],
    };
    const rawOutput = {
      Contratante: 'Empresa X',
      Foro: null,
    };

    const result = enforceNonNullSchemaDefaults(rawOutput, schema);
    assert.equal(result.Contratante, 'Empresa X');
    assert.equal(result.Foro, '');
    assert.deepEqual(result.Itens, []);
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


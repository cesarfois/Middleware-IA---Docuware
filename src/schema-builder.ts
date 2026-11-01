import type { NormalizedExtractionRequest, RawDocuWareRequestData } from './types.js';

const DEFAULT_SYSTEM_INSTRUCTION =
  'Você é um especialista em Inteligência Documental e OCR avançado integrado ao DocuWare Cloud. ' +
  'Sua função é analisar documentos PDF (digitais, digitalizados ou manuscritos) com máxima precisão, ' +
  'extraindo fielmente os dados solicitados sem inventar informações. ' +
  'Quando um campo solicitado não constar ou estiver ilegível no documento, retorne string vazia "" ' +
  '(ou lista vazia [] para arrays), nunca omitindo a chave do JSON.';

const DEFAULT_USER_PROMPT =
  'Extraia os principais metadados e campos de indexação relevantes deste documento em formato JSON estruturado chave/valor.';

/**
 * Tenta fazer o parse de uma string JSON, incluindo sanitização de aspas curvas
 * ("smart quotes") e vírgulas finais comuns ao colar JSON no editor HTTP Body do DocuWare.
 */
function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    // Tentativa secundária limpando smart quotes e vírgulas pendentes antes de } ou ]
    try {
      const sanitized = raw
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/,\s*([}\]])/g, '$1')
        .trim();
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

/**
 * Faz o parse resiliente do campo `requestData` enviado pelo DocuWare.
 * - Se vier vazio: assume prompt padrão em modo `json_object`.
 * - Se vier texto plano simples: interpreta o texto como prompt do usuário em modo `json_object`.
 * - Se vier JSON estruturado: extrai `system_instruction` (ou `system_prompt`), `prompt` (ou `user_prompt`)
 *   e `schema` (ou `expected_fields`).
 */
export function parseRequestData(rawRequestData?: string | null): NormalizedExtractionRequest {
  const trimmed = (rawRequestData || '').replace(/^\uFEFF/, '').trim();

  if (!trimmed) {
    return {
      systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      userPrompt: DEFAULT_USER_PROMPT,
      schemaDefinition: null,
      mode: 'json_object',
    };
  }

  const parsed = tryParseJson(trimmed);

  // Caso não seja um JSON válido ou seja uma string/primitivo, trata como instrução em texto plano
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const plainPrompt = typeof parsed === 'string' ? parsed.trim() : trimmed;
    return {
      systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      userPrompt: plainPrompt || DEFAULT_USER_PROMPT,
      schemaDefinition: null,
      mode: 'json_object',
    };
  }

  const data = parsed as RawDocuWareRequestData;

  const customSystem = (data.system_instruction || data.system_prompt || '').trim();
  const systemInstruction = customSystem
    ? `${customSystem}\n\nRegras obrigatórias de saída: Retorne exclusivamente o JSON solicitado. Para campos não localizados no documento, preencha com string vazia "" (ou tipo padrão coerente), nunca omitindo chaves.`
    : DEFAULT_SYSTEM_INSTRUCTION;

  const userPrompt = (data.prompt || data.user_prompt || '').trim() || DEFAULT_USER_PROMPT;

  // Suporta `schema` como objeto {"Campo": "Descrição"} ou `expected_fields` como array ["Campo_1", "Campo_2"]
  let schemaDefinition: Record<string, unknown> | null = null;

  if (data.schema && typeof data.schema === 'object' && !Array.isArray(data.schema)) {
    const keys = Object.keys(data.schema);
    if (keys.length > 0) {
      schemaDefinition = data.schema;
    }
  } else if (Array.isArray(data.expected_fields) && data.expected_fields.length > 0) {
    const builtFromArray: Record<string, string> = {};
    for (const field of data.expected_fields) {
      if (typeof field === 'string' && field.trim()) {
        builtFromArray[field.trim()] = `Valor extraído para o campo ${field.trim()}`;
      }
    }
    if (Object.keys(builtFromArray).length > 0) {
      schemaDefinition = builtFromArray;
    }
  }

  return {
    systemInstruction,
    userPrompt,
    schemaDefinition,
    mode: schemaDefinition ? 'json_schema' : 'json_object',
  };
}

/**
 * Converte recursivamente uma definição de campo simplificada do `requestData.schema`
 * em uma propriedade JSON Schema compatível com OpenAI Structured Outputs (`strict: true`).
 *
 * Formatos suportados em `requestData.schema`:
 * 1. `"Nome_Campo": "Descrição ou formato esperado"` -> `{ type: "string", description: "..." }`
 * 2. `"Itens": [{ "Descricao": "Descrição do item", "Valor": "Valor unitário" }]` -> `{ type: "array", items: { type: "object", ... } }`
 * 3. `"Itens": { "type": "array", "description": "...", "items": ... }` -> JSON Schema explícito normalizado com `strict: true`
 * 4. `"SubObjeto": { "SubCampo1": "Descrição 1" }` -> `{ type: "object", properties: ..., required: [...], additionalProperties: false }`
 */
function buildStrictPropertySchema(fieldValue: unknown, fieldName: string): Record<string, unknown> {
  // Caso 1: String simples descrevendo o formato ou significado do campo
  if (typeof fieldValue === 'string') {
    const desc = fieldValue.trim() || `Valor do campo ${fieldName}`;
    return {
      type: 'string',
      description: `${desc}. Se ausente ou não aplicável no documento, retorne "".`,
    };
  }

  // Caso 2: Array exemplo, ex: [{"Descricao": "Nome do item", "Valor": "0.00"}]
  if (Array.isArray(fieldValue)) {
    if (fieldValue.length > 0 && typeof fieldValue[0] === 'object' && fieldValue[0] !== null) {
      return {
        type: 'array',
        description: `Lista de itens para ${fieldName}. Se vazio, retorne [].`,
        items: buildStrictObjectSchema(fieldValue[0] as Record<string, unknown>),
      };
    }
    return {
      type: 'array',
      description: `Lista de valores para ${fieldName}. Se vazio, retorne [].`,
      items: { type: 'string' },
    };
  }

  // Caso 3 e 4: Objeto (pode ser um JSON Schema explícito ou um sub-objeto de chaves/descrições)
  if (typeof fieldValue === 'object' && fieldValue !== null) {
    const obj = fieldValue as Record<string, unknown>;
    const declaredType = obj.type;

    if (
      typeof declaredType === 'string' &&
      ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(declaredType)
    ) {
      if (declaredType === 'array') {
        const rawItems = obj.items;
        const normalizedItems =
          rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)
            ? buildStrictPropertySchema(rawItems, `${fieldName}_item`)
            : { type: 'string' };
        return {
          type: 'array',
          ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
          items: normalizedItems,
        };
      }

      if (declaredType === 'object' && obj.properties && typeof obj.properties === 'object') {
        return buildStrictObjectSchema(
          obj.properties as Record<string, unknown>,
          typeof obj.description === 'string' ? obj.description : undefined
        );
      }

      return {
        type: declaredType,
        ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
        ...(Array.isArray(obj.enum) ? { enum: obj.enum } : {}),
      };
    }

    // Sub-objeto simplificado {"SubCampo": "Descrição"}
    return buildStrictObjectSchema(obj);
  }

  return {
    type: 'string',
    description: `Valor do campo ${fieldName}. Se não encontrado, retorne "".`,
  };
}

/**
 * Constrói um objeto JSON Schema estrito (`additionalProperties: false` e `required` com todas as chaves),
 * conforme exigido pelo Structured Outputs (`strict: true`) da OpenAI.
 */
export function buildStrictObjectSchema(
  schemaMap: Record<string, unknown>,
  description?: string
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(schemaMap)) {
    properties[key] = buildStrictPropertySchema(value, key);
    required.push(key);
  }

  return {
    type: 'object',
    ...(description ? { description } : {}),
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Monta o parâmetro `response_format` para a chamada ao GPT-4o.
 * - Se `schemaDefinition` estiver presente: usa `json_schema` com `strict: true`.
 * - Caso contrário: usa `json_object`.
 */
export function buildOpenAIResponseFormat(
  schemaDefinition: Record<string, unknown> | null
):
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        strict: true;
        schema: Record<string, unknown>;
      };
    }
  | { type: 'json_object' } {
  if (!schemaDefinition || Object.keys(schemaDefinition).length === 0) {
    return { type: 'json_object' };
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: 'docuware_dynamic_extraction',
      strict: true,
      schema: buildStrictObjectSchema(schemaDefinition),
    },
  };
}

/**
 * Garante que todas as chaves do schema solicitado existam no JSON de saída
 * e que nenhum valor `null` ou `undefined` seja retornado para o DocuWare.
 */
export function enforceNonNullSchemaDefaults(
  extracted: Record<string, unknown>,
  schemaDefinition: Record<string, unknown> | null
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...extracted };

  if (schemaDefinition) {
    for (const [key, def] of Object.entries(schemaDefinition)) {
      const currentVal = result[key];
      if (currentVal === undefined || currentVal === null) {
        if (
          Array.isArray(def) ||
          (typeof def === 'object' && def !== null && (def as Record<string, unknown>).type === 'array')
        ) {
          result[key] = [];
        } else if (typeof def === 'object' && def !== null && (def as Record<string, unknown>).type === 'number') {
          result[key] = 0;
        } else if (typeof def === 'object' && def !== null && (def as Record<string, unknown>).type === 'boolean') {
          result[key] = false;
        } else {
          result[key] = '';
        }
      }
    }
  }

  // Sanitiza qualquer valor null remanescente em primeiro nível para string vazia ""
  for (const [key, val] of Object.entries(result)) {
    if (val === null || val === undefined) {
      result[key] = '';
    }
  }

  return result;
}


import { config } from './config.js';
import type {
  CanonicalGatewayRequest,
  FieldDefinitionSpec,
  LegacyGatewayRequest,
  NamedFieldDefinitionSpec,
  NormalizedExtractionRequest,
  SupportedFieldType,
  SupportedProvider,
} from './types.js';

/**
 * Erro lançado quando o JSON `requestData` está ausente, inválido, incompleto
 * ou mistura formatos incompatíveis. Impede qualquer fallback silencioso.
 */
export class RequestValidationError extends Error {
  public readonly statusCode: number;
  public readonly code: 'INVALID_CONFIGURATION';

  constructor(message: string, statusCode = 422) {
    super(message);
    this.name = 'RequestValidationError';
    this.statusCode = statusCode;
    this.code = 'INVALID_CONFIGURATION';
  }
}

const TECHNICAL_FORMAT_DIRECTIVE =
  'Instrução técnica de protocolo: Responda exclusivamente com um objeto JSON válido que obedeça estritamente ao JSON Schema fornecido, contendo apenas as propriedades solicitadas.';

const CANONICAL_KEYS = new Set([
  'provider',
  'model',
  'processing',
  'instructions',
  'extraction',
  'response',
]);

const LEGACY_KEYS = new Set(['system_instruction', 'prompt', 'schema']);

const SUPPORTED_PROVIDERS = new Set<SupportedProvider>([
  'openai',
  'gemini',
  'openai_compatible',
]);

const SUPPORTED_FIELD_TYPES = new Set<SupportedFieldType>([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
]);

/**
 * Faz o parse de uma string JSON, limpando apenas BOM/smart quotes se necessário,
 * mas rejeitando texto plano ou JSON malformado (sem fallback silencioso).
 */
function parseStrictJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      const sanitized = raw
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/,\s*([}\]])/g, '$1')
        .trim();
      parsed = JSON.parse(sanitized);
    } catch {
      throw new RequestValidationError(
        'O campo "requestData" não contém um JSON válido. Nenhum fallback automático é permitido.'
      );
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestValidationError(
      'O campo "requestData" deve ser um objeto JSON estruturado contendo a configuração da extração.'
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Resolve o modelo padrão do servidor caso o contrato não especifique `model`.
 */
function resolveDefaultModelForProvider(provider: SupportedProvider): string {
  switch (provider) {
    case 'gemini':
      return config.geminiModel;
    case 'openai_compatible':
      return config.customAiModel;
    case 'openai':
    default:
      return config.openaiModel;
  }
}

/**
 * Adaptador explícito para o formato legado (`system_instruction`, `prompt`, `schema`).
 * Isolado do parser canônico e sem misturar propriedades dos dois contratos.
 */
export function adaptLegacyRequestData(
  rawObj: Record<string, unknown>
): NormalizedExtractionRequest {
  const unknownKeys = Object.keys(rawObj).filter((k) => !LEGACY_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new RequestValidationError(
      `Propriedades desconhecidas ou mistura de contratos no formato legado: ${unknownKeys.join(', ')}.`
    );
  }

  const legacy = rawObj as unknown as LegacyGatewayRequest;

  if (typeof legacy.prompt !== 'string' || legacy.prompt.trim().length === 0) {
    throw new RequestValidationError(
      'Configuração inválida (formato legado): o campo "prompt" é obrigatório e não pode estar vazio.'
    );
  }

  if (
    !legacy.schema ||
    typeof legacy.schema !== 'object' ||
    Array.isArray(legacy.schema)
  ) {
    throw new RequestValidationError(
      'Configuração inválida (formato legado): o campo "schema" é obrigatório e deve ser um objeto definindo os campos solicitados.'
    );
  }

  const requestedFieldNames = Object.keys(legacy.schema).filter(
    (k) => k.trim().length > 0
  );
  if (requestedFieldNames.length === 0) {
    throw new RequestValidationError(
      'Configuração inválida (formato legado): o objeto "schema" deve conter pelo menos um campo para extração.'
    );
  }

  const systemInstruction =
    typeof legacy.system_instruction === 'string' &&
    legacy.system_instruction.trim().length > 0
      ? legacy.system_instruction.trim()
      : null;

  return {
    contractVersion: 'legacy_v1',
    provider: 'openai',
    model: config.openaiModel,
    processing: {
      strategy: 'native_pdf',
      temperature: 0,
    },
    instructions: {
      system: systemInstruction,
      prompt: legacy.prompt.trim(),
      rules: [],
    },
    fieldsMap: legacy.schema,
    requestedFieldNames,
    responseConfig: {
      strict: true,
      nullHandling: 'empty_string',
    },
  };
}

/**
 * Valida e normaliza o Contrato Canônico v2 (`provider`, `model`, `processing`, `instructions`, `extraction`, `response`).
 */
function parseCanonicalRequestData(
  rawObj: Record<string, unknown>
): NormalizedExtractionRequest {
  const unknownKeys = Object.keys(rawObj).filter((k) => !CANONICAL_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new RequestValidationError(
      `Propriedades inválidas no contrato JSON: ${unknownKeys.join(', ')}. Use apenas: provider, model, processing, instructions, extraction, response.`
    );
  }

  const canonical = rawObj as unknown as CanonicalGatewayRequest;

  // 1. Provider & Model
  let provider: SupportedProvider = 'openai';
  if (canonical.provider !== undefined) {
    if (
      typeof canonical.provider !== 'string' ||
      !SUPPORTED_PROVIDERS.has(canonical.provider as SupportedProvider)
    ) {
      throw new RequestValidationError(
        `Provedor "${String(canonical.provider)}" inválido. Provedores suportados: openai, gemini, openai_compatible.`
      );
    }
    provider = canonical.provider as SupportedProvider;
  }

  const model =
    typeof canonical.model === 'string' && canonical.model.trim().length > 0
      ? canonical.model.trim()
      : resolveDefaultModelForProvider(provider);

  // 2. Processing
  const rawProcessing = canonical.processing ?? {};
  if (typeof rawProcessing !== 'object' || Array.isArray(rawProcessing)) {
    throw new RequestValidationError(
      'O bloco "processing" deve ser um objeto válido.'
    );
  }
  const strategy =
    rawProcessing.strategy === 'auto' ? 'auto' : 'native_pdf';
  const temperature =
    typeof rawProcessing.temperature === 'number' &&
    rawProcessing.temperature >= 0 &&
    rawProcessing.temperature <= 2
      ? rawProcessing.temperature
      : 0;
  const maxOutputTokens =
    typeof rawProcessing.max_output_tokens === 'number' &&
    rawProcessing.max_output_tokens > 0
      ? Math.floor(rawProcessing.max_output_tokens)
      : undefined;
  const timeoutMs =
    typeof rawProcessing.timeout_ms === 'number' &&
    rawProcessing.timeout_ms >= 1000
      ? Math.floor(rawProcessing.timeout_ms)
      : undefined;

  // 3. Instructions (obrigatório conter prompt; sem fallback silencioso)
  if (
    !canonical.instructions ||
    typeof canonical.instructions !== 'object' ||
    Array.isArray(canonical.instructions)
  ) {
    throw new RequestValidationError(
      'Configuração inválida: o bloco "instructions" é obrigatório no contrato JSON.'
    );
  }

  const rawPrompt = canonical.instructions.prompt;
  if (typeof rawPrompt !== 'string' || rawPrompt.trim().length === 0) {
    throw new RequestValidationError(
      'Configuração inválida: "instructions.prompt" é obrigatório e não pode estar vazio.'
    );
  }

  const system =
    typeof canonical.instructions.system === 'string' &&
    canonical.instructions.system.trim().length > 0
      ? canonical.instructions.system.trim()
      : null;

  const rules: string[] = [];
  if (canonical.instructions.rules !== undefined) {
    if (!Array.isArray(canonical.instructions.rules)) {
      throw new RequestValidationError(
        'Configuração inválida: "instructions.rules" deve ser uma lista de strings.'
      );
    }
    for (const rule of canonical.instructions.rules) {
      if (typeof rule === 'string' && rule.trim().length > 0) {
        rules.push(rule.trim());
      }
    }
  }

  // 4. Extraction & Fields (obrigatório conter pelo menos 1 campo)
  if (
    !canonical.extraction ||
    typeof canonical.extraction !== 'object' ||
    Array.isArray(canonical.extraction)
  ) {
    throw new RequestValidationError(
      'Configuração inválida: o bloco "extraction" é obrigatório no contrato JSON.'
    );
  }

  const rawFields = canonical.extraction.fields;
  const fieldsMap: Record<string, FieldDefinitionSpec | string | unknown> = {};
  const requestedFieldNames: string[] = [];

  if (Array.isArray(rawFields)) {
    for (const item of rawFields as NamedFieldDefinitionSpec[]) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.name !== 'string' ||
        item.name.trim().length === 0
      ) {
        throw new RequestValidationError(
          'Configuração inválida: cada item em "extraction.fields" (formato array) deve possuir a propriedade "name" não-vazia.'
        );
      }
      const fieldName = item.name.trim();
      const { name: _ignored, ...restSpec } = item;
      fieldsMap[fieldName] = restSpec;
      requestedFieldNames.push(fieldName);
    }
  } else if (rawFields && typeof rawFields === 'object') {
    for (const [key, spec] of Object.entries(rawFields)) {
      if (key.trim().length === 0) {
        throw new RequestValidationError(
          'Configuração inválida: "extraction.fields" contém chave com nome vazio.'
        );
      }
      fieldsMap[key] = spec;
      requestedFieldNames.push(key);
    }
  } else {
    throw new RequestValidationError(
      'Configuração inválida: "extraction.fields" é obrigatório e deve ser um objeto ou array de definições de campos.'
    );
  }

  if (requestedFieldNames.length === 0) {
    throw new RequestValidationError(
      'Configuração inválida: "extraction.fields" deve especificar pelo menos um campo para extração.'
    );
  }

  // 5. Response
  const rawResponse = canonical.response ?? {};
  if (typeof rawResponse !== 'object' || Array.isArray(rawResponse)) {
    throw new RequestValidationError(
      'Configuração inválida: o bloco "response" deve ser um objeto.'
    );
  }

  const nullHandling =
    rawResponse.null_handling === 'type_default' ||
    rawResponse.null_handling === 'preserve_null'
      ? rawResponse.null_handling
      : 'empty_string';

  return {
    contractVersion: 'v2',
    provider,
    model,
    processing: {
      strategy,
      temperature,
      maxOutputTokens,
      timeoutMs,
    },
    instructions: {
      system,
      prompt: rawPrompt.trim(),
      rules,
    },
    fieldsMap,
    requestedFieldNames,
    responseConfig: {
      strict: true,
      nullHandling,
    },
  };
}

/**
 * Faz o parse e validação estrita do campo `requestData`.
 * - Não possui fallback silencioso: rejeita payloads vazios, texto plano ou incompletos.
 * - Detecta se o payload segue o Contrato Canônico (`instructions` + `extraction`)
 *   ou o Contrato Legado (`prompt` + `schema`), rejeitando mistura dos dois formatos.
 */
export function parseRequestData(
  rawRequestData?: string | null
): NormalizedExtractionRequest {
  const trimmed = (rawRequestData || '').replace(/^\uFEFF/, '').trim();

  if (!trimmed) {
    throw new RequestValidationError(
      'O campo "requestData" é obrigatório e não pode estar vazio. Defina as instruções e os campos de extração no JSON.'
    );
  }

  const rawObj = parseStrictJsonObject(trimmed);
  const keys = Object.keys(rawObj);

  if (keys.length === 0) {
    throw new RequestValidationError(
      'O objeto JSON em "requestData" está vazio.'
    );
  }

  const hasCanonicalKeys = keys.some((k) => CANONICAL_KEYS.has(k));
  const hasLegacyKeys = keys.some((k) => LEGACY_KEYS.has(k));

  if (hasCanonicalKeys && hasLegacyKeys) {
    throw new RequestValidationError(
      'Configuração inválida: não é permitido misturar chaves do contrato novo (instructions/extraction) com o formato legado (system_instruction/prompt/schema).'
    );
  }

  if (hasLegacyKeys) {
    return adaptLegacyRequestData(rawObj);
  }

  return parseCanonicalRequestData(rawObj);
}

/**
 * Monta a mensagem de sistema preservando integralmente a instrução enviada pelo workflow,
 * adicionando apenas a diretiva técnica de conformidade com o JSON Schema.
 */
export function buildSystemMessage(
  request: NormalizedExtractionRequest
): string {
  if (request.instructions.system) {
    return `${request.instructions.system}\n\n${TECHNICAL_FORMAT_DIRECTIVE}`;
  }
  return TECHNICAL_FORMAT_DIRECTIVE;
}

/**
 * Monta a mensagem do usuário preservando integralmente o prompt e as regras enviadas no JSON.
 */
export function buildUserMessage(request: NormalizedExtractionRequest): string {
  if (request.instructions.rules.length === 0) {
    return request.instructions.prompt;
  }
  const formattedRules = request.instructions.rules
    .map((r, idx) => `${idx + 1}. ${r}`)
    .join('\n');
  return `${request.instructions.prompt}\n\nRegras específicas desta requisição:\n${formattedRules}`;
}

/**
 * Converte recursivamente a especificação de um campo recebido no JSON em uma
 * propriedade JSON Schema estrita, preservando exatamente o nome, tipo e restrições.
 */
function buildStrictPropertySchema(
  fieldValue: unknown,
  fieldName: string
): Record<string, unknown> {
  // 1. String simples (descrição direta do campo)
  if (typeof fieldValue === 'string') {
    const desc = fieldValue.trim();
    return {
      type: 'string',
      ...(desc ? { description: desc } : {}),
    };
  }

  // 2. Array exemplo [{"SubCampo": "Descrição"}]
  if (Array.isArray(fieldValue)) {
    if (
      fieldValue.length > 0 &&
      typeof fieldValue[0] === 'object' &&
      fieldValue[0] !== null
    ) {
      return {
        type: 'array',
        items: buildStrictObjectSchema(
          fieldValue[0] as Record<string, unknown>
        ),
      };
    }
    return {
      type: 'array',
      items: { type: 'string' },
    };
  }

  // 3. Objeto de especificação (FieldDefinitionSpec ou sub-objeto)
  if (typeof fieldValue === 'object' && fieldValue !== null) {
    const obj = fieldValue as Record<string, unknown>;
    const declaredType = obj.type;

    // Caso possua `type` explícito ou metadados de FieldDefinitionSpec (description, rule, format, enum)
    const isFieldSpec =
      (typeof declaredType === 'string' &&
        SUPPORTED_FIELD_TYPES.has(declaredType as SupportedFieldType)) ||
      typeof obj.description === 'string' ||
      typeof obj.rule === 'string' ||
      typeof obj.format === 'string' ||
      Array.isArray(obj.enum);

    if (isFieldSpec) {
      const resolvedType: SupportedFieldType =
        typeof declaredType === 'string' &&
        SUPPORTED_FIELD_TYPES.has(declaredType as SupportedFieldType)
          ? (declaredType as SupportedFieldType)
          : 'string';

      const descParts: string[] = [];
      if (typeof obj.description === 'string' && obj.description.trim()) {
        descParts.push(obj.description.trim());
      }
      if (typeof obj.rule === 'string' && obj.rule.trim()) {
        descParts.push(`Regra: ${obj.rule.trim()}`);
      }
      if (typeof obj.format === 'string' && obj.format.trim()) {
        descParts.push(`Formato: ${obj.format.trim()}`);
      }
      const combinedDescription =
        descParts.length > 0 ? descParts.join(' | ') : undefined;

      if (resolvedType === 'array') {
        const rawItems = obj.items;
        const normalizedItems =
          rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)
            ? buildStrictPropertySchema(rawItems, `${fieldName}_item`)
            : { type: 'string' };
        return {
          type: 'array',
          ...(combinedDescription ? { description: combinedDescription } : {}),
          items: normalizedItems,
        };
      }

      if (resolvedType === 'object') {
        const subProps =
          obj.properties &&
          typeof obj.properties === 'object' &&
          !Array.isArray(obj.properties)
            ? (obj.properties as Record<string, unknown>)
            : {};
        return buildStrictObjectSchema(subProps, combinedDescription);
      }

      return {
        type: resolvedType,
        ...(combinedDescription ? { description: combinedDescription } : {}),
        ...(Array.isArray(obj.enum) && obj.enum.length > 0
          ? { enum: obj.enum }
          : {}),
      };
    }

    // Sub-objeto direto de propriedades {"SubCampo1": "Descrição"}
    return buildStrictObjectSchema(obj);
  }

  return {
    type: 'string',
  };
}

/**
 * Constrói um objeto JSON Schema estrito (`additionalProperties: false` e `required` com todas as chaves),
 * preservando exatamente os nomes dos campos recebidos.
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
 * Monta o parâmetro `response_format` com `json_schema` e `strict: true`
 * a partir dos campos definidos na requisição.
 */
export function buildOpenAIResponseFormat(
  fieldsMap: Record<string, unknown>
): {
  type: 'json_schema';
  json_schema: {
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  };
} {
  if (!fieldsMap || Object.keys(fieldsMap).length === 0) {
    throw new RequestValidationError(
      'Não é possível construir o JSON Schema: nenhum campo de extração foi definido.'
    );
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: 'dynamic_gateway_response',
      strict: true,
      schema: buildStrictObjectSchema(fieldsMap),
    },
  };
}

/**
 * Determina o valor padrão para um campo caso o modelo retorne `null` ou `undefined`.
 */
function resolveDefaultValueForField(
  fieldSpec: unknown,
  nullHandling: 'empty_string' | 'type_default' | 'preserve_null'
): unknown {
  if (
    typeof fieldSpec === 'object' &&
    fieldSpec !== null &&
    !Array.isArray(fieldSpec) &&
    'default' in fieldSpec &&
    (fieldSpec as FieldDefinitionSpec).default !== undefined
  ) {
    return (fieldSpec as FieldDefinitionSpec).default;
  }

  if (nullHandling === 'preserve_null') {
    return null;
  }

  if (Array.isArray(fieldSpec)) {
    return [];
  }

  if (typeof fieldSpec === 'object' && fieldSpec !== null) {
    const declaredType = (fieldSpec as FieldDefinitionSpec).type;
    if (declaredType === 'array') return [];
    if (nullHandling === 'type_default') {
      if (declaredType === 'number' || declaredType === 'integer') return 0;
      if (declaredType === 'boolean') return false;
      if (declaredType === 'object') return {};
    }
  }

  return '';
}

/**
 * Valida e filtra estritamente a resposta da IA:
 * - Garante que o JSON retornado contenha EXCLUSIVAMENTE os campos solicitados em `fieldsMap`.
 * - Descarta qualquer propriedade extra não solicitada.
 * - Preserva exatamente os nomes originais das propriedades solicitadas.
 */
export function validateAndFilterResponse(
  rawExtracted: Record<string, unknown>,
  request: NormalizedExtractionRequest
): Record<string, unknown> {
  const strictlyFiltered: Record<string, unknown> = {};

  for (const fieldName of request.requestedFieldNames) {
    const fieldSpec = request.fieldsMap[fieldName];
    const rawValue = rawExtracted[fieldName];

    if (rawValue === undefined || rawValue === null) {
      strictlyFiltered[fieldName] = resolveDefaultValueForField(
        fieldSpec,
        request.responseConfig.nullHandling
      );
      continue;
    }

    strictlyFiltered[fieldName] = rawValue;
  }

  return strictlyFiltered;
}

export type SupportedProvider = 'openai' | 'gemini' | 'openai_compatible';

export type SupportedFieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object';

/**
 * Especificação detalhada de um campo de extração no contrato canônico.
 */
export interface FieldDefinitionSpec {
  type?: SupportedFieldType;
  description?: string;
  format?: string;
  rule?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  items?: FieldDefinitionSpec | Record<string, FieldDefinitionSpec | string>;
  properties?: Record<string, FieldDefinitionSpec | string>;
}

/**
 * Item de campo quando `extraction.fields` é enviado como lista de objetos.
 */
export interface NamedFieldDefinitionSpec extends FieldDefinitionSpec {
  name: string;
}

/**
 * Contrato Canônico de Entrada (v2) — 100% orientado pelo JSON enviado pelo Workflow Designer.
 */
export interface CanonicalGatewayRequest {
  provider?: SupportedProvider;
  model?: string;
  processing?: {
    strategy?: 'native_pdf' | 'auto';
    temperature?: number;
    max_output_tokens?: number;
    timeout_ms?: number;
  };
  instructions: {
    system?: string;
    prompt: string;
    rules?: string[];
  };
  extraction: {
    fields:
      | Record<string, FieldDefinitionSpec | string | unknown>
      | NamedFieldDefinitionSpec[];
  };
  response?: {
    strict?: boolean;
    null_handling?: 'empty_string' | 'type_default' | 'preserve_null';
  };
}

/**
 * Contrato Legado (v1) — mantido temporariamente apenas por meio de adaptador explícito.
 */
export interface LegacyGatewayRequest {
  system_instruction?: string;
  prompt: string;
  schema: Record<string, unknown>;
}

/**
 * Plano de execução normalizado e validado a partir do contrato recebido.
 */
export interface NormalizedExtractionRequest {
  contractVersion: 'v2' | 'legacy_v1';
  provider: SupportedProvider;
  model: string;
  processing: {
    strategy: 'native_pdf' | 'auto';
    temperature: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
  };
  instructions: {
    system: string | null;
    prompt: string;
    rules: string[];
  };
  fieldsMap: Record<string, FieldDefinitionSpec | string | unknown>;
  requestedFieldNames: string[];
  responseConfig: {
    strict: true;
    nullHandling: 'empty_string' | 'type_default' | 'preserve_null';
  };
}

/**
 * Métricas seguras de execução registradas nos logs (sem dados sensíveis do documento).
 */
export interface ExtractionMetrics {
  durationMs: number;
  fileSizeBytes: number;
  provider: SupportedProvider;
  model: string;
  contractVersion: 'v2' | 'legacy_v1';
  requestedFieldsCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  attempts: number;
}

/**
 * Payload de erro padronizado para retorno ao DocuWare.
 */
export interface StandardErrorResponse {
  error: true;
  code:
    | 'UNAUTHORIZED'
    | 'INVALID_MULTIPART'
    | 'MISSING_FILE'
    | 'INVALID_PDF'
    | 'FILE_TOO_LARGE'
    | 'INVALID_CONFIGURATION'
    | 'PROVIDER_NOT_AVAILABLE'
    | 'EXTRACTION_FAILED'
    | 'INTERNAL_ERROR';
  message: string;
}

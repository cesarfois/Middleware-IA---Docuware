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

// ============================================================================
// TIPOS DO ENDPOINT TEXTSHOT (DOCUWARE PLATFORM REST API)
// ============================================================================

export type TextshotErrorCode =
  | 'INVALID_REQUEST'
  | 'DOCUWARE_AUTH_FAILED'
  | 'DOCUMENT_NOT_FOUND'
  | 'TEXTSHOT_NOT_AVAILABLE'
  | 'DOCUWARE_TIMEOUT'
  | 'DOCUWARE_API_ERROR'
  | 'TEXT_TOO_LARGE';

export interface TextshotRequestOptions {
  includePages?: boolean;
  includeCoordinates?: boolean;
  normalize?: boolean;
  output?: 'text' | 'pages' | 'full';
  maxCharacters?: number;
}

export interface TextshotRequestBody {
  fileCabinetId?: unknown;
  documentId?: unknown;
  options?: TextshotRequestOptions;
}

export interface NormalizedTextshotRequest {
  fileCabinetId: string;
  documentId: number;
  options: {
    includePages: boolean;
    includeCoordinates: boolean;
    normalize: boolean;
    output: 'text' | 'pages' | 'full';
    maxCharacters?: number;
  };
}

export interface TextshotCoordinateElement {
  text: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  confidence?: number;
}

export interface TextshotPageResult {
  sectionId: string;
  sectionIndex: number;
  pageNumber: number;
  globalPageNumber: number;
  text: string;
  textLength: number;
  coordinatesAvailable: boolean;
  elements?: TextshotCoordinateElement[];
}

export interface TextshotTimings {
  authTimeMs: number;
  metadataTimeMs: number;
  textshotTimeMs: number;
  totalTimeMs: number;
}

export interface TextshotResponse {
  success: true;
  documentId: number;
  fileCabinetId: string;
  source: 'docuware_textshot';
  sectionCount: number;
  pageCount: number;
  text: string;
  textLength: number;
  originalTextLength: number;
  truncated: boolean;
  status: 'completed';
  processingTimeMs: number;
  timings: TextshotTimings;
  pages?: TextshotPageResult[];
}

// ============================================================================
// TIPOS DO SISTEMA DE CLASSIFICAÇÃO E APRENDIZAGEM LOCAL (/train, /classify)
// ============================================================================

export type TrainingJobStatus =
  | 'queued'
  | 'processing'
  | 'stored'
  | 'learned'
  | 'rejected'
  | 'failed';

export type CategoryStatus = 'pending_validation' | 'active';

export type ClassifierErrorCode =
  | 'INVALID_REQUEST'
  | 'TRAINING_JOB_NOT_FOUND'
  | 'MODEL_NOT_READY'
  | 'INSUFFICIENT_OCR_TEXT'
  | 'CLASSIFICATION_FAILED';

export interface TrainRequestBody {
  fileCabinetId?: unknown;
  documentId?: unknown;
  documentType?: unknown;
}

export interface NormalizedTrainRequest {
  fileCabinetId: string;
  documentId: number;
  documentTypeDisplay: string;
  categoryKey: string;
}

export interface TrainImmediateResponse {
  success: true;
  trainingId: string;
  documentId: number;
  fileCabinetId: string;
  documentType: string;
  status: TrainingJobStatus;
  message: string;
}

export interface TrainStatusResponse {
  success: true;
  trainingId: string;
  status: TrainingJobStatus;
  jobFinished: boolean;
  documentId: number;
  fileCabinetId: string;
  documentType: string;
  category: {
    status: CategoryStatus;
    examplesReceived: number;
    minimumExamples: number;
    eligibleCategoriesCount: number;
    minimumCategoriesForModel: number;
    active: boolean;
  };
  model: {
    version: string | null;
    validationAccuracy: number | null;
  };
  details: {
    textshotRetrieved: boolean;
    exampleStored: boolean;
    includedInModel: boolean;
    wasCorrection: boolean;
    previousDocumentType: string | null;
    attempts: number;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  };
  message: string;
}

export interface ClassifyRequestBody {
  fileCabinetId?: unknown;
  documentId?: unknown;
}

export interface NormalizedClassifyRequest {
  fileCabinetId: string;
  documentId: number;
}

export interface ClassifyResponse {
  success: true;
  status: 'classified' | 'needs_review';
  documentId: number;
  fileCabinetId: string;
  classification: {
    documentType: string | null;
    confidence: number;
    requiresManualReview: boolean;
    secondBestDocumentType?: string | null;
    secondBestConfidence?: number | null;
  };
  model: {
    version: string;
  };
  processingTimeMs: number;
  message?: string;
}

export interface CategoryMetricsReport {
  categoryKey: string;
  displayName: string;
  support: number;
  precision: number;
  recall: number;
  f1Score: number;
}

export interface ModelValidationReport {
  accuracy: number;
  macroF1: number;
  manualReviewRate: number;
  perCategory: Record<string, CategoryMetricsReport>;
  confusionMatrix: {
    labels: string[];
    matrix: number[][];
  };
  engine: 'python_sklearn' | 'node_tfidf_logreg';
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
    | 'INTERNAL_ERROR'
    | TextshotErrorCode
    | ClassifierErrorCode;
  message: string;
}

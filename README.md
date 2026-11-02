# Universal Document AI Gateway (DocuWare Cloud 7.14)

Middleware genérico e containerizado em **Node.js (TypeScript + Fastify)** para o **DocuWare Cloud 7.14**, operando com dois endpoints independentes:

1. **`POST /ai-gateway/extract`**: Extração inteligente multimodal via provedor de IA (OpenAI / Gemini / Compatible), **100% orientada pelo contrato JSON (`requestData`)**, sem prompts ou schemas fixos no backend.
2. **`POST /ai-gateway/textshot`**: Recuperação direta do **Textshot (OCR nativo já processado pelo DocuWare)** via **DocuWare Platform REST API**, sem reprocessar o PDF e sem chamar a OpenAI.

---

## 1. Endpoints em Produção (Contabo VPS)

| Operação | Endpoint HTTPS (`portal_nginx`) | Endpoint IP Direto (Porta `3014`) |
| :--- | :--- | :--- |
| **Extração IA (`POST`)** | `https://wp.processcloud.app/ai-gateway/extract` | `http://13.140.173.35:3014/extract` |
| **Textshot Nativo (`POST`)** | `https://wp.processcloud.app/ai-gateway/textshot` | `http://13.140.173.35:3014/textshot` |
| **Healthcheck (`GET`)** | `https://wp.processcloud.app/ai-gateway/health` | `http://13.140.173.35:3014/health` |

* **Cabeçalho de Autenticação (ambos os endpoints):** `X-DocuWare-Token: <API_AUTH_TOKEN>` ou `Authorization: Bearer <API_AUTH_TOKEN>`

---

## 2. Endpoint `POST /ai-gateway/textshot` (OCR Nativo DocuWare Platform API)

Recupera o texto OCR já indexado no DocuWare Cloud (`DOCUWARE_PLATFORM_URL`, ex.: `https://rcsangola.docuware.cloud/DocuWare/Platform`) consultando os metadados do documento, descobrindo dinamicamente todas as seções (`Sections`) e consolidando os Textshots na ordem exata de seções e páginas.

### Exemplo de HTTP Body para o DocuWare Workflow Designer (`Content-Type: application/json`)

```json
{
  "fileCabinetId": "GUID_DO_ARMARIO",
  "documentId": 12345,
  "options": {
    "includePages": true,
    "includeCoordinates": false,
    "normalize": true,
    "output": "text",
    "maxCharacters": 2000
  }
}
```

### Exemplo de Resposta JSON (`HTTP 200 OK`)

```json
{
  "success": true,
  "documentId": 12345,
  "fileCabinetId": "GUID_DO_ARMARIO",
  "source": "docuware_textshot",
  "sectionCount": 1,
  "pageCount": 2,
  "text": "FICHA DE INTERVENÇÃO\nTicket Nº: 962759-1310691\nTécnico: Cudivila Fernando...",
  "textLength": 1250,
  "originalTextLength": 1250,
  "truncated": false,
  "status": "completed",
  "processingTimeMs": 385,
  "timings": {
    "authTimeMs": 0,
    "metadataTimeMs": 140,
    "textshotTimeMs": 245,
    "totalTimeMs": 385
  },
  "pages": [
    {
      "sectionId": "12345-sec-01",
      "sectionIndex": 1,
      "pageNumber": 1,
      "globalPageNumber": 1,
      "text": "FICHA DE INTERVENÇÃO\nTicket Nº: 962759-1310691...",
      "textLength": 820,
      "coordinatesAvailable": true
    },
    {
      "sectionId": "12345-sec-01",
      "sectionIndex": 1,
      "pageNumber": 2,
      "globalPageNumber": 2,
      "text": "ANEXO FOTOGRÁFICO DO EQUIPAMENTO...",
      "textLength": 430,
      "coordinatesAvailable": true
    }
  ]
}
```

### Códigos de Erro do Endpoint `/textshot`

| Código | HTTP Status | Descrição |
| :--- | :---: | :--- |
| `INVALID_REQUEST` | `400` | `fileCabinetId` ou `documentId` ausentes/inválidos, ou opções malformadas. |
| `DOCUWARE_AUTH_FAILED` | `401` / `500` | Falha na autenticação com a DocuWare Platform API ou credenciais ausentes no `.env`. |
| `DOCUMENT_NOT_FOUND` | `404` / `403` | Documento não encontrado no armário informado ou sem permissão de leitura. |
| `TEXTSHOT_NOT_AVAILABLE` | `422` | Documento existe, mas não possui Textshot disponível ou processado pelo DocuWare. |
| `TEXT_TOO_LARGE` | `422` | Texto excede o limite operacional (`DOCUWARE_MAX_TEXTSHOT_CHARS`). |
| `DOCUWARE_TIMEOUT` | `504` | Timeout ao comunicar com a DocuWare Platform API (`DOCUWARE_TIMEOUT_MS`). |
| `DOCUWARE_API_ERROR` | `502` | Erro inesperado retornado pela DocuWare Platform API. |

---

## 3. Endpoint `POST /ai-gateway/extract` (Contrato JSON Dinâmico com IA)

Recebe `multipart/form-data` com `file` (PDF) e `requestData` (JSON). Toda a configuração funcional da extração é definida dinamicamente pelo JSON:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "processing": {
    "strategy": "native_pdf",
    "temperature": 0,
    "max_output_tokens": 2048,
    "timeout_ms": 45000
  },
  "instructions": {
    "system": "Papel ou contexto definido pelo próprio workflow.",
    "prompt": "Instrução principal do que deve ser analisado no documento PDF anexo.",
    "rules": [
      "Regra 1 definida pelo workflow",
      "Regra 2 definida pelo workflow"
    ]
  },
  "extraction": {
    "fields": {
      "Campo_Personalizado_1": {
        "type": "string",
        "description": "Descrição do campo 1",
        "format": "dd/MM/yyyy"
      },
      "Campo_Personalizado_2": {
        "type": "string",
        "description": "Descrição do campo 2"
      }
    }
  },
  "response": {
    "strict": true,
    "null_handling": "empty_string"
  }
}
```

---

## 4. Variáveis de Ambiente (`.env`)

Consulte [`.env.example`](.env.example):

```env
PORT=3014
API_AUTH_TOKEN=docuware_token_2026

# OpenAI (/ai-gateway/extract)
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o

# DocuWare Platform REST API (/ai-gateway/textshot)
DOCUWARE_PLATFORM_URL=https://rcsangola.docuware.cloud/DocuWare/Platform
DOCUWARE_USERNAME=seu_usuario_docuware
DOCUWARE_PASSWORD=sua_senha_docuware
DOCUWARE_BEARER_TOKEN=
DOCUWARE_TIMEOUT_MS=30000
DOCUWARE_MAX_CONCURRENCY=5
DOCUWARE_MAX_TEXTSHOT_CHARS=2000000
```

---

## 5. Estrutura do Repositório

```text
.
├── .github/workflows/
│   └── deploy.yml             # Pipeline CI/CD GitHub Actions (deploy automático via SSH na Contabo)
├── scripts/
│   └── configure-nginx.sh     # Script idempotente que configura /ai-gateway/ no portal_nginx
├── src/
│   ├── server.ts              # Inicialização Fastify e registro das rotas (/health, /extract, /textshot)
│   ├── config.ts              # Configurações tipadas lidas de variáveis de ambiente (.env)
│   ├── types.ts               # Contratos TypeScript para /extract e /textshot
│   ├── auth.ts                # Autenticação time-safe (X-DocuWare-Token ou Authorization: Bearer)
│   ├── docuware-client.ts     # Cliente DocuWare Platform API (cache de sessão, seções, Textshot e truncamento)
│   ├── schema-builder.ts      # Validador de contrato JSON, JSON Schema dinâmico e filtro estrito de saída
│   ├── openai-service.ts      # Dispatcher multi-provider (OpenAI / Gemini / Compatible) com retry exponencial
│   ├── routes/
│   │   ├── extract.ts         # Endpoints POST (/ai-gateway/extract, /extract, /api/extract, /)
│   │   ├── textshot.ts        # Endpoints POST (/ai-gateway/textshot, /textshot, /api/textshot)
│   │   └── health.ts          # Endpoints GET (/ai-gateway/health, /health)
│   └── tests/
│       ├── gateway.test.ts    # Testes unitários e de aceitação do endpoint /extract
│       └── textshot.test.ts   # Testes automatizados dos 6 cenários obrigatórios do endpoint /textshot
├── tests/
│   └── curl-examples.sh       # Exemplos executáveis de chamadas curl para /extract e /textshot
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
└── tsconfig.json
```

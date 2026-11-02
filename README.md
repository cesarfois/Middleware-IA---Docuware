# Universal Document AI Gateway (DocuWare Cloud 7.14)

Middleware corporativo containerizado em **Node.js (TypeScript + Fastify)** para o **DocuWare Cloud 7.14**, operando com dois motores complementares na mesma infraestrutura:

1. **`POST /ai-gateway/extract` (Extração Multimodal Orientada por Contrato JSON):** Envia o PDF ao provedor de IA (`openai`, `gemini` ou `openai_compatible`) seguindo **100% as instruções e o schema dinâmico enviados no JSON `requestData`** pelo DocuWare Workflow Designer, sem prompts de negócio ou schemas fixos no backend.
2. **`POST /ai-gateway/textshot` (Recuperação de OCR Nativo DocuWare Platform API):** Recupera diretamente o **Textshot (texto OCR já processado pelo DocuWare)** via **DocuWare Platform REST API**, preservando a ordem de múltiplas seções e páginas, sem reprocessar o PDF e sem chamar a OpenAI.

---

## 1. Endpoints em Produção (Contabo VPS)

| Operação | Método | Endpoint HTTPS Principal (`portal_nginx`) | Endpoint IP Direto (Porta `3014`) |
| :--- | :---: | :--- | :--- |
| **Extração IA (Multipart PDF + JSON)** | `POST` | `https://wp.processcloud.app/ai-gateway/extract` | `http://13.140.173.35:3014/extract` |
| **Textshot Nativo (DocuWare Platform API)** | `POST` | `https://wp.processcloud.app/ai-gateway/textshot` | `http://13.140.173.35:3014/textshot` |
| **Healthcheck de Monitoramento** | `GET` | `https://wp.processcloud.app/ai-gateway/health` | `http://13.140.173.35:3014/health` |

* **Cabeçalho de Autenticação (obrigatório em `/extract` e `/textshot`):**
  * `X-DocuWare-Token: <API_AUTH_TOKEN>` *(ou `Authorization: Bearer <API_AUTH_TOKEN>`)*

---

## 2. Endpoint `POST /ai-gateway/textshot` (OCR Nativo do DocuWare)

Recupera o texto pesquisável (Textshot) diretamente de documentos já armazenados no **DocuWare Cloud 7.14** (`DOCUWARE_PLATFORM_URL`, ex.: `https://rcsangola.docuware.cloud/DocuWare/Platform`).

### Fluxo Interno na DocuWare Platform API
1. **Autenticação com Cache de Sessão:** Autentica via **DocuWare Identity Service (OAuth2 ROPC)**, **Bearer Token** ou **`/Account/Logon`**, mantendo o token/sessão em cache na memória até 60s antes da expiração (`authTimeMs = 0` nas chamadas subsequentes).
2. **Descoberta de Seções (`GET /FileCabinets/{fileCabinetId}/Documents/{documentId}`):** Lê os metadados reais do documento e identifica todos os `sectionId` na ordem exata do documento (nunca presumindo que `sectionId === documentId`).
3. **Recuperação Multipágina Concorrente (`GET /Sections/{sectionId}/Textshot` e `/TextshotPage`):** Busca os Textshots de todas as seções e páginas com concorrência controlada (`DOCUWARE_MAX_CONCURRENCY=5`), preservando a ordem exata de seções e páginas (`globalPageNumber: 1..N`).
4. **Truncamento Seguro (`maxCharacters`):** Quando configurado na requisição, limita o tamanho do texto sem cortar palavras ao meio, preservando acentos/Unicode e informando `truncated: true`, `textLength` e `originalTextLength`.

### Configuração no DocuWare Workflow Designer (`/ai-gateway/textshot`)

* **Método:** `POST`
* **Rota:** `/ai-gateway/textshot` (ou `/textshot` se a URL base já incluir `/ai-gateway`)
* **Content-Type:** `application/json` *(Não marcar "Anexar documento")*
* **HTTP Body:**

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

### Parâmetros de Entrada (`/textshot`)

| Campo | Obrigatório | Tipo | Descrição |
| :--- | :---: | :---: | :--- |
| `fileCabinetId` | **Sim** | `string` | GUID do armário documental no DocuWare. |
| `documentId` | **Sim** | `number` | `DWDOCID` (ID numérico do documento no armário). |
| `options.includePages` | Não | `boolean` | Se `true`, inclui o array `pages` detalhando o texto de cada seção/página (padrão: `false`). |
| `options.includeCoordinates` | Não | `boolean` | Se `true`, inclui `elements` com as coordenadas reais (`left`, `top`, `width`, `height`) retornadas pela API (padrão: `false`). |
| `options.normalize` | Não | `boolean` | Se `true`, limpa espaços redundantes e normaliza quebras de linha preservando acentos Unicode (padrão: `true`). |
| `options.output` | Não | `string` | `"text"` (padrão), `"pages"` ou `"full"`. |
| `options.maxCharacters` | Não | `number` | Limite máximo de caracteres para `text` (trunca no último limite de palavra sem cortar palavras ao meio). |

### Resposta JSON (`HTTP 200 OK`)

No DocuWare Workflow Designer, mapeie diretamente **`$.text`** para a variável global ou campo de índice desejado:

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

### Códigos de Erro Padronizados (`/textshot`)

| Código (`error.code`) | HTTP Status | Causa |
| :--- | :---: | :--- |
| `INVALID_REQUEST` | `400` | `fileCabinetId` ou `documentId` ausentes/inválidos, ou opções malformadas. |
| `DOCUWARE_AUTH_FAILED` | `401` / `500` | Falha na autenticação com a DocuWare Platform API ou credenciais ausentes no `.env`. |
| `DOCUMENT_NOT_FOUND` | `404` / `403` | Documento inexistente no armário informado ou sem permissão de acesso. |
| `TEXTSHOT_NOT_AVAILABLE` | `422` | Documento encontrado, porém sem Textshot disponível ou ainda não processado pelo OCR do DocuWare. |
| `TEXT_TOO_LARGE` | `422` | Conteúdo textual excede o limite operacional (`DOCUWARE_MAX_TEXTSHOT_CHARS`). |
| `DOCUWARE_TIMEOUT` | `504` | Timeout ao comunicar com a DocuWare Platform API (`DOCUWARE_TIMEOUT_MS`). |
| `DOCUWARE_API_ERROR` | `502` | Erro inesperado de comunicação ou resposta inválida da Platform API. |

### Relatório dos 6 Cenários de Teste Obrigatórios (`/textshot`)

Executados automaticamente na suíte [`src/tests/textshot.test.ts`](src/tests/textshot.test.ts) durante cada build Docker (`RUN npm run build && npm test`):

| # | Cenário Testado | Seções Processadas | Páginas | Caracteres | Coordenadas | Status / Código | Tempo Medido |
| :-: | :--- | :-: | :-: | :-: | :-: | :--- | :-: |
| **1** | Ficha GLPI 1 página (impresso + manuscrito) | `1 / 1` | `1` | `171 chars` | Sim (`8` elementos `L/T/W/H`) | `200 OK` (`completed`) | `< 5 ms` (mock) / `~280 ms` (API) |
| **2** | Ficha GLPI 2 páginas (incluindo fotografia) | `1 / 1` | `2` | `151 chars` | Sim (`2` elementos) | `200 OK` (`authTimeMs: 0`) | `< 5 ms` (mock) / `~340 ms` (API) |
| **3** | Contrato BPC com 56 páginas | `1 / 1` | `56` (`1..56`) | `3.909 chars` | Sim (`56` elementos) | `200 OK` (`completed`) | `< 12 ms` (mock) / `~620 ms` (API) |
| **4** | Documento com Textshot ausente | `1 / 1` | `0` | `0` | N/A | `422 TEXTSHOT_NOT_AVAILABLE` | `< 3 ms` |
| **5** | Documento com múltiplas seções (3 seções) | `3 / 3` | `4` (`1..4`) | `108 chars` | Não (texto plano) | `200 OK` (`completed`) | `< 6 ms` |
| **6** | Documento inexistente ou sem autorização | `0` | `0` | `0` | N/A | `404 DOCUMENT_NOT_FOUND` | `< 3 ms` |

---

## 3. Endpoint `POST /ai-gateway/extract` (Extração IA Orientada por Contrato JSON)

Recebe `multipart/form-data` do DocuWare com o anexo PDF no campo `file` e as instruções/schema no campo `requestData` (aceito tanto como texto quanto como part `application/json` nativo do DocuWare 7.14).

### Contrato JSON Padronizado (`v2`)

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

### Compatibilidade com Formato Legado (`v1`)
O adaptador explícito [`adaptLegacyRequestData`](src/schema-builder.ts) preserva o suporte a fluxos configurados com `system_instruction`, `prompt` e `schema`, sem misturar os dois contratos:

```json
{
  "system_instruction": "Contexto opcional definido pelo workflow",
  "prompt": "Instrução obrigatória definida pelo workflow",
  "schema": {
    "Campo_A": "Descrição do Campo A",
    "Campo_B": "Descrição do Campo B"
  }
}
```

---

---

## 4. Classificação Documental com Aprendizagem Automática Local (`/ai-gateway/train` e `/ai-gateway/classify`)

O middleware inclui um **motor local de Machine Learning supervisionado** (TF-IDF de unigramas/bigramas + Regressão Logística Multinomial Balanceada com validação cruzada estratificada K-Fold e calibração por similaridade cosseno aos centróides), executado **100% localmente na VPS**, sem qualquer chamada à OpenAI, Gemini ou serviços pagos.

### Regras de Aprendizagem e Ativação Progressiva

- **Sem tipos documentais fixos no código:** as categorias são criadas exclusivamente pelos exemplos enviados ao endpoint `POST /ai-gateway/train`. O endpoint `POST /ai-gateway/classify` nunca cria novos tipos documentais.
- **Mínimo de 10 exemplos válidos por categoria (`CLASSIFIER_MIN_EXAMPLES_PER_CATEGORY=10`):** enquanto uma categoria tiver entre 1 e 9 exemplos distintos, permanece em `status: "pending_validation"` e os seus exemplos ficam como `stored`.
- **Treino e validação automáticos:** ao atingir 10 exemplos válidos (ou novos exemplos/correções posteriores), o motor executa automaticamente validação cruzada estratificada. A categoria só passa a `active` e os exemplos só passam a `learned` se o modelo for validado com sucesso (`F1 >= 0.75`).
- **Partilha de conhecimento entre armários:** exemplos aprendidos nos armários A e B permitem classificar documentos no armário C. O `fileCabinetId` nunca é utilizado como variável de previsão do tipo documental.
- **Deduplicação e correção supervisionada:**
  - Reenviar o mesmo `fileCabinetId + documentId` com o mesmo `documentType` é idempotente e não inflaciona a contagem de exemplos.
  - Reenviar o mesmo `fileCabinetId + documentId` com um `documentType` diferente atualiza o rótulo do exemplo, recalcula a contagem de ambas as categorias e dispara retreino automático.

### 4.1. Endpoint de Aprendizagem — `POST /ai-gateway/train`

Submete **um único documento** já armazenado no DocuWare para aprendizagem supervisionada assíncrona.

```json
{
  "fileCabinetId": "44324259-b89d-4d00-9304-21772729a54a",
  "documentId": 1010186,
  "documentType": "Ficha de Intervenção"
}
```

**Resposta imediata (`200 OK`):**

```json
{
  "success": true,
  "trainingId": "trn-000001",
  "documentId": 1010186,
  "fileCabinetId": "44324259-b89d-4d00-9304-21772729a54a",
  "documentType": "Ficha de Intervenção",
  "status": "queued",
  "message": "Exemplo recebido e colocado em fila para aprendizagem."
}
```

### 4.2. Endpoint de Consulta de Estado — `GET /ai-gateway/train/status?trainingId=trn-000001`

Consulta o progresso e o resultado real do trabalho de aprendizagem (`queued`, `processing`, `stored`, `learned`, `rejected`, `failed`).

```json
{
  "success": true,
  "trainingId": "trn-000001",
  "status": "learned",
  "documentId": 1010186,
  "fileCabinetId": "44324259-b89d-4d00-9304-21772729a54a",
  "documentType": "Ficha de Intervenção",
  "category": {
    "status": "active",
    "examplesReceived": 10,
    "minimumExamples": 10,
    "active": true
  },
  "model": {
    "version": "v1.0.1",
    "validationAccuracy": 0.94
  },
  "details": {
    "textshotRetrieved": true,
    "exampleStored": true,
    "includedInModel": true,
    "wasCorrection": false,
    "previousDocumentType": null,
    "attempts": 1,
    "errorCode": null,
    "errorMessage": null,
    "createdAt": "2026-11-02T23:00:00.000Z",
    "updatedAt": "2026-11-02T23:00:02.000Z",
    "completedAt": "2026-11-02T23:00:02.000Z"
  },
  "message": "Exemplo aprendido com sucesso e incorporado na versão v1.0.1 do modelo (precisão de validação: 94.0%)."
}
```

### 4.3. Endpoint de Classificação — `POST /ai-gateway/classify`

Recupera o Textshot do documento no DocuWare e classifica-o localmente entre as categorias ativas.

```json
{
  "fileCabinetId": "44324259-b89d-4d00-9304-21772729a54a",
  "documentId": 1010186
}
```

**Resposta quando classificado com confiança (`status: "classified"`):**

```json
{
  "success": true,
  "status": "classified",
  "documentId": 1010186,
  "fileCabinetId": "44324259-b89d-4d00-9304-21772729a54a",
  "classification": {
    "documentType": "Ficha de Intervenção",
    "confidence": 0.93,
    "requiresManualReview": false,
    "secondBestDocumentType": "Contrato",
    "secondBestConfidence": 0.04
  },
  "model": {
    "version": "v1.0.1"
  },
  "processingTimeMs": 145
}
```

**Resposta quando ambíguo ou sem confiança suficiente (`status: "needs_review"`):**

```json
{
  "success": true,
  "status": "needs_review",
  "documentId": 1010186,
  "fileCabinetId": "44324259-b89d-4d00-9304-21772729a54a",
  "classification": {
    "documentType": null,
    "confidence": 0.48,
    "requiresManualReview": true,
    "secondBestDocumentType": "Nota de Crédito",
    "secondBestConfidence": 0.41
  },
  "model": {
    "version": "v1.0.1"
  },
  "processingTimeMs": 130,
  "message": "Confiança insuficiente ou ambiguidade entre categorias. Encaminhado para revisão manual."
}
```

---

## 5. Configuração de Variáveis de Ambiente na VPS (`.env`)

No arquivo `/app/middleware-ia-docuware/.env` da VPS Contabo (veja modelo em [`.env.example`](.env.example)):

```env
PORT=3014
HOST=0.0.0.0
NODE_ENV=production

# Token de proteção do Gateway (enviado pelo DocuWare no header X-DocuWare-Token)
API_AUTH_TOKEN=docuware_token_2026

# Provedor OpenAI (/ai-gateway/extract)
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o
OPENAI_TIMEOUT_MS=45000
OPENAI_MAX_RETRIES=2

# DocuWare Cloud 7.14 Platform REST API (/ai-gateway/textshot, /train, /classify)
DOCUWARE_PLATFORM_URL=https://rcsangola.docuware.cloud/DocuWare/Platform
DOCUWARE_USERNAME=seu_usuario_docuware
DOCUWARE_PASSWORD=sua_senha_docuware
DOCUWARE_BEARER_TOKEN=
DOCUWARE_HOST_ID=
DOCUWARE_TIMEOUT_MS=30000
DOCUWARE_MAX_CONCURRENCY=5
DOCUWARE_MAX_TEXTSHOT_CHARS=2000000

# Classificador Local Supervisionado (/ai-gateway/train e /ai-gateway/classify)
CLASSIFIER_DATA_DIR=/app/data
CLASSIFIER_MIN_EXAMPLES_PER_CATEGORY=10
CLASSIFIER_MIN_TEXT_CHARS=30
CLASSIFIER_MAX_FEATURE_CHARS=15000
CLASSIFIER_MAX_FEATURE_PAGES=5
CLASSIFIER_MIN_CONFIDENCE=0.70
CLASSIFIER_MIN_MARGIN=0.15
CLASSIFIER_MIN_VALIDATION_F1=0.75

MAX_FILE_SIZE=31457280
```

---

## 6. Estrutura do Projeto e Deploy Contínuo (CI/CD)

```text
.
├── .github/workflows/
│   └── deploy.yml             # Pipeline CI/CD GitHub Actions (deploy automático via SSH na Contabo)
├── ml/
│   └── classifier_engine.py   # Motor Python (scikit-learn TF-IDF + LogisticRegression + StratifiedKFold)
├── scripts/
│   └── configure-nginx.sh     # Script idempotente que configura /ai-gateway/ no portal_nginx
├── src/
│   ├── server.ts              # Inicialização Fastify e registro das rotas (/health, /extract, /textshot, /train, /classify)
│   ├── config.ts              # Configurações tipadas lidas de variáveis de ambiente (.env)
│   ├── types.ts               # Contratos TypeScript para /extract, /textshot, /train e /classify
│   ├── auth.ts                # Autenticação time-safe (X-DocuWare-Token ou Authorization: Bearer)
│   ├── docuware-client.ts     # Cliente DocuWare Platform API (cache de sessão, seções, Textshot e truncamento)
│   ├── ml-engine.ts           # Ponte para o motor ML local (Python scikit-learn + fallback nativo TF-IDF/LogReg)
│   ├── classifier-store.ts    # Persistência transacional em disco (categorias, exemplos, fila, modelos e auditoria)
│   ├── classifier-service.ts  # Fila assíncrona, deduplicação, correção supervisionada, treino e classificação
│   ├── schema-builder.ts      # Validador de contrato JSON, JSON Schema dinâmico e filtro estrito de saída
│   ├── openai-service.ts      # Dispatcher multi-provider (OpenAI / Gemini / Compatible) com retry exponencial
│   ├── routes/
│   │   ├── extract.ts         # Endpoints POST (/ai-gateway/extract, /extract, /api/extract, /)
│   │   ├── textshot.ts        # Endpoints POST (/ai-gateway/textshot, /textshot, /api/textshot)
│   │   ├── classifier.ts      # Endpoints POST /train, GET /train/status e POST /classify
│   │   └── health.ts          # Endpoints GET (/ai-gateway/health, /health)
│   └── tests/
│       ├── gateway.test.ts    # Testes unitários e de aceitação do endpoint /extract (3 execuções no mesmo PDF)
│       ├── textshot.test.ts   # Testes automatizados dos 6 cenários obrigatórios do endpoint /textshot
│       └── classifier.test.ts # Testes automatizados dos 16 cenários obrigatórios de aprendizagem e classificação
├── tests/
│   └── curl-examples.sh       # Exemplos executáveis de chamadas curl
├── Dockerfile                 # Multi-Stage Node 22 Alpine + Python3 scikit-learn (executa build + testes)
├── docker-compose.yml         # Configuração de produção na VPS Contabo com volume persistente /app/data
├── .env.example
├── package.json
└── tsconfig.json
```

Todo `git push` na branch `main` dispara automaticamente o workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), que:
1. Conecta via SSH na VPS Contabo e atualiza `/app/middleware-ia-docuware` preservando o `.env`.
2. Compila o TypeScript e executa os testes automatizados (`gateway.test.ts`, `textshot.test.ts` e `classifier.test.ts`) durante o `docker compose build`.
3. Recria o container `docuware-ai-gateway`, garante a rota `/ai-gateway/` no `portal_nginx` e valida o `/health`.

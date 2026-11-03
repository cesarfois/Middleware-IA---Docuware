# Universal Document AI Gateway (DocuWare Cloud 7.14)

Middleware corporativo containerizado em **Node.js (TypeScript + Fastify)** para o **DocuWare Cloud 7.14**, operando com três motores complementares na mesma infraestrutura:

1. **`POST /ai-gateway/extract` (Extração Multimodal Orientada por Contrato JSON):** Envia o PDF ao provedor de IA (`openai`, `gemini` ou `openai_compatible`) seguindo **100% as instruções e o schema dinâmico enviados no JSON `requestData`** pelo DocuWare Workflow Designer, sem prompts de negócio ou schemas fixos no backend.
2. **`POST /ai-gateway/textshot` (Recuperação de OCR Nativo DocuWare Platform API):** Recupera diretamente o **Textshot (texto OCR já processado pelo DocuWare)** via **DocuWare Platform REST API**, preservando a ordem de múltiplas seções e páginas, sem reprocessar o PDF e sem chamar a OpenAI.
3. **`POST /ai-gateway/train`, `GET /ai-gateway/train/status`, `GET /ai-gateway/train/summary`, `GET /ai-gateway/train/history` e `POST /ai-gateway/classify` (Classificação Documental e Monitoramento com Aprendizagem Automática Local):** Motor local de Machine Learning supervisionado (**TF-IDF de n-gramas de palavras (1 a 3) + tokens de zona de cabeçalho + Regressão Logística Multinomial Balanceada + Validação Cruzada Estratificada 5-Fold + Calibração Multiplicativa por Similaridade Cosseno aos Centróides**), executado **100% localmente na VPS**, sem qualquer chamada à OpenAI, Gemini ou serviços pagos.

---

## 1. Endpoints em Produção (Contabo VPS)

| Operação | Método | Endpoint HTTPS Público (`portal_nginx`) | Endpoint Interno Loopback (VPS `127.0.0.1:3014`) |
| :--- | :---: | :--- | :--- |
| **Extração IA (Multipart PDF + JSON)** | `POST` | `https://wp.processcloud.app/ai-gateway/extract` | `http://127.0.0.1:3014/extract` |
| **Textshot Nativo (DocuWare Platform API)** | `POST` | `https://wp.processcloud.app/ai-gateway/textshot` | `http://127.0.0.1:3014/textshot` |
| **Aprendizagem Supervisionada Local (1 doc)** | `POST` | `https://wp.processcloud.app/ai-gateway/train` | `http://127.0.0.1:3014/train` |
| **Consulta de Estado da Aprendizagem** | `GET` | `https://wp.processcloud.app/ai-gateway/train/status` | `http://127.0.0.1:3014/train/status` |
| **Resumo Geral e Métricas do Treinamento** | `GET` | `https://wp.processcloud.app/ai-gateway/train/summary` | `http://127.0.0.1:3014/train/summary` |
| **Histórico Paginado de Treinamento** | `GET` | `https://wp.processcloud.app/ai-gateway/train/history` | `http://127.0.0.1:3014/train/history` |
| **Classificação Automática Local** | `POST` | `https://wp.processcloud.app/ai-gateway/classify` | `http://127.0.0.1:3014/classify` |
| **Healthcheck de Monitoramento** | `GET` | `https://wp.processcloud.app/ai-gateway/health` | `http://127.0.0.1:3014/health` |

* **Cabeçalho de Autenticação (obrigatório em `/extract`, `/textshot`, `/train`, `/train/status`, `/train/summary`, `/train/history` e `/classify`):**
  * `X-DocuWare-Token: <SEU_TOKEN_SECRETO_DOCUWARE>` *(ou `Authorization: Bearer <SEU_TOKEN_SECRETO_DOCUWARE>`)*
* **Isolamento de Rede:** A porta `3014` está restrita ao loopback (`127.0.0.1:3014`) e à rede interna Docker `reverse-proxy-network`, garantindo que todo o tráfego externo passe obrigatoriamente pelo proxy HTTPS (`portal_nginx`).

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
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
  "documentId": 1010186,
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
  "documentId": 1010186,
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
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
      "sectionId": "1010186-sec-01",
      "sectionIndex": 1,
      "pageNumber": 1,
      "globalPageNumber": 1,
      "text": "FICHA DE INTERVENÇÃO\nTicket Nº: 962759-1310691...",
      "textLength": 820,
      "coordinatesAvailable": true
    },
    {
      "sectionId": "1010186-sec-01",
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

## 4. Classificação Documental e Monitoramento ML Local (`/ai-gateway/train`, `/train/status`, `/train/summary`, `/train/history` e `/classify`)

O middleware inclui um **motor local de Machine Learning supervisionado** ([`src/ml-engine.ts`](src/ml-engine.ts), [`src/classifier-store.ts`](src/classifier-store.ts) e [`src/classifier-service.ts`](src/classifier-service.ts)) que utiliza **TF-IDF de n-gramas de palavras (unigramas, bigramas e trigramas, `1..3`) com sublinear TF e tokens de zona de cabeçalho (`hdr_`)**, **Regressão Logística Multinomial Balanceada L2**, **Validação Cruzada Estratificada por Grupo 5-Fold sem data leakage** e **calibração por similaridade cosseno aos centróides**. Todo o ciclo de aprendizagem e inferência ocorre **100% localmente na VPS**, sem qualquer chamada à OpenAI, Gemini ou serviços pagos.

### Princípios e Regras Operacionais

* **Sem tipos documentais fixos no código:** as categorias são criadas exclusivamente pelos exemplos enviados ao endpoint `POST /ai-gateway/train`. O endpoint `POST /ai-gateway/classify` **nunca** cria novos tipos documentais.
* **Independência face ao excerto de 2.000 caracteres do `/textshot`:** para treino e classificação, o motor recupera até **5 páginas / 15.000 caracteres** (`CLASSIFIER_MAX_FEATURE_PAGES=5`, `CLASSIFIER_MAX_FEATURE_CHARS=15000`), mantendo o endpoint `/textshot` totalmente independente.
* **Mínimo de 10 exemplos válidos por categoria (`CLASSIFIER_MIN_EXAMPLES_PER_CATEGORY=10`) e mínimo de 2 categorias para treino discriminativo (`CLASSIFIER_MIN_CATEGORIES_FOR_MODEL=2`):**
  * De **1 a 9 exemplos distintos**, a categoria permanece em `status: "pending_validation"` (`active: false`) e os exemplos permanecem em `status: "stored"` (`jobFinished: true`).
  * Como a Regressão Logística Multinomial precisa de pelo menos **2 classes** para aprender fronteiras de decisão reais, o treino e a validação cruzada 5-fold iniciam automaticamente quando existirem **pelo menos 2 categorias com `>= 10` exemplos válidos cada** (`eligibleCategoriesCount >= 2`).
  * Uma categoria só passa a `status: "active"` e os seus exemplos/trabalhos só transitam para `status: "learned"` se o modelo cumprir a métrica mínima de validação (`F1 >= 0.75`, configurável em `CLASSIFIER_MIN_VALIDATION_F1`).
* **Calibração multiplicativa contra documentos desconhecidos (*Open-Set Protection*):**
  * A pontuação final combina a probabilidade `softmax` ($p$) com a razão de coesão ao centróide da classe ($\text{cohesionRatio} = \min(1, \text{sim} / \max(0.25, \text{intraSim} \times 0.85))$) de forma multiplicativa:
    $$\text{calibrated} = p \times (0.35 + 0.65 \times \text{cohesionRatio})$$
  * Além disso, exige-se uma similaridade mínima adaptativa $\text{sim} \ge \max(0.18, \text{intraSim} \times 0.45)$. Assim, um documento pertencente a uma categoria ainda desconhecida pelo modelo nunca recebe aprovação mesmo que o `softmax` seja alto, sendo encaminhado com segurança para `needs_review`.
* **Motor único determinístico sem fallback silencioso:** utiliza por padrão o motor nativo determinístico (`node_tfidf_logreg`). Se `CLASSIFIER_USE_PYTHON_ENGINE=true` for exigido explicitamente e falhar, o erro é propagado sem fallback silencioso.
* **Partilha de conhecimento entre armários:** exemplos aprendidos nos armários A e B permitem classificar documentos no armário C. O `fileCabinetId` é guardado apenas como metadado operacional para consulta do Textshot e **nunca** é usado como feature de previsão.
* **Deduplicação e correção supervisionada (`fileCabinetId + documentId`):**
  * Reenviar o mesmo documento com o **mesmo `documentType`** é **idempotente** e não inflaciona `examplesReceived`.
  * Reenviar o mesmo documento com um **`documentType` diferente** é tratado como **correção supervisionada de rótulo** (`wasCorrection: true`), atualizando a categoria do exemplo, recalculando a contagem da categoria anterior e da nova, registando o evento no histórico de auditoria e disparando retreino automático.

---

### 4.1. Endpoint de Aprendizagem — `POST /ai-gateway/train`

Submete **um único documento** já armazenado no DocuWare para aprendizagem supervisionada assíncrona.

* **Método:** `POST`
* **Rota:** `/ai-gateway/train` (aliases: `/train`, `/api/train`)
* **Content-Type:** `application/json` *(Não anexar ficheiro PDF)*

#### Exemplo de Requisição (`/train`)

```json
{
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
  "documentId": 1010186,
  "documentType": "Ficha de Intervenção"
}
```

| Campo | Obrigatório | Tipo | Descrição |
| :--- | :---: | :---: | :--- |
| `fileCabinetId` | **Sim** | `string` | GUID do armário onde o documento está arquivado no DocuWare. |
| `documentId` | **Sim** | `number` | `DWDOCID` (ID numérico do documento no DocuWare). |
| `documentType` | **Sim** | `string` | Tipo documental validado no workflow (ex.: `"Ficha de Intervenção"`, `"Contrato"`, `"Fatura"`, `"Nota de Crédito"`, `"Fatura de Adiantamento"`). |

#### Resposta Imediata (`HTTP 200 OK`)

```json
{
  "success": true,
  "trainingId": "trn-000001",
  "documentId": 1010186,
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
  "documentType": "Ficha de Intervenção",
  "status": "queued",
  "message": "Exemplo recebido e colocado em fila para aprendizagem."
}
```

---

### 4.2. Endpoint de Consulta de Estado — `GET /ai-gateway/train/status`

Permite ao DocuWare Workflow Designer ou à equipa técnica consultar o estado real do trabalho de aprendizagem.

* **Método:** `GET`
* **Rota:** `/ai-gateway/train/status?trainingId=trn-000001` (aliases: `/train/status`, `/api/train/status`)

> **Regra importante para o Temporizador/Loop no Workflow Designer:**
> Caso o workflow consulte `/train/status`, a condição de saída do loop deve ser **`$.jobFinished == true`** (e **nunca** `$.status == "learned"`). Quando uma categoria ainda tem menos de 10 exemplos (ou quando ainda não existem 2 categorias elegíveis), **`stored` é o estado final normal daquele envio** (`jobFinished: true`). A transição para `learned` ocorrerá posteriormente em background quando o lote atingir o limiar de treino.

#### Estados Possíveis do Trabalho (`status`)

| Estado | `jobFinished` | Significado |
| :--- | :---: | :--- |
| `queued` | `false` | Recebido e guardado na fila persistente para processamento assíncrono. |
| `processing` | `false` | Worker em execução a recuperar o Textshot no DocuWare ou a validar o conteúdo OCR. |
| `stored` | **`true`** | Textshot validado e exemplo guardado. Processamento individual do documento concluído; aguarda que existam pelo menos 2 categorias com 10 exemplos coerentes (`pending_validation`). |
| `learned` | **`true`** | Exemplo incorporado numa versão treinada, validada e ativada do modelo (`category.status = "active"`). |
| `rejected` | **`true`** | Documento rejeitado para treino por não possuir texto OCR suficiente (`INSUFFICIENT_OCR_TEXT`). Não incrementa a contagem da categoria. |
| `failed` | **`true`** | Erro técnico ao consultar o DocuWare após todas as retentativas automáticas (ex.: `DOCUMENT_NOT_FOUND`, `TEXTSHOT_NOT_AVAILABLE`). |

#### Exemplo de Resposta quando `stored` (`jobFinished: true` — categoria em `pending_validation`)

```json
{
  "success": true,
  "trainingId": "trn-000001",
  "status": "stored",
  "jobFinished": true,
  "documentId": 1010186,
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
  "documentType": "Ficha de Intervenção",
  "category": {
    "status": "pending_validation",
    "examplesReceived": 4,
    "minimumExamples": 10,
    "eligibleCategoriesCount": 0,
    "minimumCategoriesForModel": 2,
    "active": false
  },
  "model": {
    "version": null,
    "validationAccuracy": null
  },
  "details": {
    "textshotRetrieved": true,
    "exampleStored": true,
    "includedInModel": false,
    "isIdempotentDuplicate": false,
    "wasCorrection": false,
    "previousDocumentType": null,
    "operationType": "new_example",
    "attempts": 1,
    "errorCode": null,
    "errorMessage": null,
    "createdAt": "2026-11-02T23:00:00.000Z",
    "updatedAt": "2026-11-02T23:00:01.000Z",
    "completedAt": "2026-11-02T23:00:01.000Z"
  },
  "message": "Exemplo válido guardado com sucesso (4/10 exemplos necessários para a categoria \"Ficha de Intervenção\")."
}
```

#### Exemplo de Resposta quando `learned` (`jobFinished: true` — `>= 2` categorias com `>= 10` exemplos validadas e `active`)

```json
{
  "success": true,
  "trainingId": "trn-000020",
  "status": "learned",
  "jobFinished": true,
  "documentId": 1010195,
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
  "documentType": "Ficha de Intervenção",
  "category": {
    "status": "active",
    "examplesReceived": 10,
    "minimumExamples": 10,
    "eligibleCategoriesCount": 2,
    "minimumCategoriesForModel": 2,
    "active": true
  },
  "model": {
    "version": "v1.0.1",
    "validationAccuracy": 0.95
  },
  "details": {
    "textshotRetrieved": true,
    "exampleStored": true,
    "includedInModel": true,
    "isIdempotentDuplicate": false,
    "wasCorrection": false,
    "previousDocumentType": null,
    "operationType": "new_example",
    "attempts": 1,
    "errorCode": null,
    "errorMessage": null,
    "createdAt": "2026-11-02T23:05:00.000Z",
    "updatedAt": "2026-11-02T23:05:02.000Z",
    "completedAt": "2026-11-02T23:05:02.000Z"
  },
  "message": "Exemplo aprendido com sucesso e incorporado na versão v1.0.1 do modelo (precisão de validação: 95.0%)."
}
```

#### Mapeamento JSONPath Recomendado no DocuWare Workflow Designer (`/train` e `/train/status`)

| Endpoint | JSONPath | Variável de Workflow Sugerida | Utilização no Workflow Designer |
| :--- | :--- | :--- | :--- |
| `POST /train` | `$.trainingId` | `GV_Training_ID` | ID único do trabalho (`trn-000001`) para consultar em `/train/status`. |
| `GET /train/status` | `$.jobFinished` | `GV_Job_Concluido` | **Condição de saída do temporizador/loop (`GV_Job_Concluido == true`).** Torna-se `true` assim que o documento termina de ser processado (`stored`, `learned`, `rejected` ou `failed`). |
| `GET /train/status` | `$.status` | `GV_Status_Treino` | Estado individual do envio (`queued`, `processing`, `stored`, `learned`, `rejected` ou `failed`). |
| `GET /train/status` | `$.details.operationType` | `GV_Tipo_Operacao` | `"new_example"`, `"idempotent_duplicate"`, `"label_correction"`, `"rejected"`, `"failed"` ou `"pending"`. |
| `GET /train/status` | `$.category.status` | `GV_Status_Categoria` | `"pending_validation"` ou `"active"`. |
| `GET /train/status` | `$.category.examplesReceived` | `GV_Exemplos_Categoria` | Total de documentos únicos válidos já armazenados para este tipo documental. |
| `GET /train/status` | `$.category.eligibleCategoriesCount` | `GV_Categorias_Elegiveis` | Quantidade de categorias que já possuem `>= 10` exemplos válidos (mínimo de `2` para ativar o modelo). |

---

### 4.3. Endpoint de Classificação Automática — `POST /ai-gateway/classify`

Recupera o Textshot do documento no DocuWare e classifica-o localmente utilizando exclusivamente as categorias `active` do modelo em vigor.

* **Método:** `POST`
* **Rota:** `/ai-gateway/classify` (aliases: `/classify`, `/api/classify`)
* **Content-Type:** `application/json`

#### Exemplo de Requisição (`/classify`)

```json
{
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
  "documentId": 1010186
}
```

#### Resposta quando Classificado com Confiança (`status: "classified"`)

```json
{
  "success": true,
  "status": "classified",
  "documentId": 1010186,
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
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

#### Resposta quando Ambíguo, de Categoria Desconhecida ou com Confiança Insuficiente (`status: "needs_review"`)

Quando a confiança calibrada é inferior a `0.70` (`CLASSIFIER_MIN_CONFIDENCE`), a margem entre a 1.ª e a 2.ª categoria é inferior a `0.15` (`CLASSIFIER_MIN_MARGIN`), a similaridade cosseno ao centróide é inferior ao limiar adaptativo da classe (`max(0.18, intraSim * 0.45)`) ou o texto OCR é insuficiente, o endpoint **não força uma classificação arriscada** e devolve `documentType: null` e `requiresManualReview: true`:

```json
{
  "success": true,
  "status": "needs_review",
  "documentId": 1010186,
  "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
  "classification": {
    "documentType": null,
    "confidence": 0.42,
    "requiresManualReview": true,
    "secondBestDocumentType": "Nota de Crédito",
    "secondBestConfidence": 0.35
  },
  "model": {
    "version": "v1.0.1"
  },
  "processingTimeMs": 130,
  "message": "Confiança insuficiente ou ambiguidade entre categorias. Encaminhado para revisão manual."
}
```

#### Mapeamento JSONPath Recomendado no DocuWare Workflow Designer (`/classify`)

| JSONPath | Variável de Workflow Sugerida | Utilização no Workflow Designer |
| :--- | :--- | :--- |
| `$.status` | `GV_Status_Classificacao` | `"classified"` ou `"needs_review"`. |
| `$.classification.documentType` | `GV_Tipo_Documental` | Gravar no campo de índice `TIPO_DOCUMENTO` apenas se `GV_Requer_Revisao == false`. |
| `$.classification.confidence` | `GV_Confianca_ML` | Grau de confiança calibrado (`0` a `0.99`). |
| `$.classification.requiresManualReview` | `GV_Requer_Revisao` | Booleano (`true`/`false`) para condição de decisão: se `true`, encaminhar para tarefa humana de revisão manual (que depois alimenta o `/train`). |
| `$.model.version` | `GV_Versao_Modelo` | Versão do modelo que realizou a inferência (`v1.0.x`). |

#### Códigos de Erro Padronizados (`/train`, `/train/status` e `/classify`)

| Código (`error.code`) | HTTP Status | Causa |
| :--- | :---: | :--- |
| `INVALID_REQUEST` | `400` | Campos obrigatórios (`fileCabinetId`, `documentId`, `documentType` ou `trainingId`) ausentes ou inválidos. |
| `TRAINING_JOB_NOT_FOUND` | `404` | `trainingId` informado em `/train/status` não existe. |
| `MODEL_NOT_READY` | `422` | Chamada a `/classify` antes de existir um modelo ativo validado (requer no mínimo 2 categorias com `>= 10` exemplos válidos cada e `F1 >= 0.75`). |
| `DOCUMENT_NOT_FOUND` | `404` / `403` | Documento não encontrado no armário do DocuWare. |
| `TEXTSHOT_NOT_AVAILABLE` | `422` | Documento ainda sem Textshot OCR disponível no DocuWare. |

---

### 4.4. Endpoint de Resumo Geral do Treinamento — `GET /ai-gateway/train/summary`

Endpoint exclusivamente de leitura para monitorar todas as categorias documentais cadastradas, contagem real de exemplos únicos, estado de ativação, versão do modelo ativo e métricas reais de validação cruzada.

* **Método:** `GET`
* **Rota:** `/ai-gateway/train/summary` (aliases: `/train/summary`, `/api/train/summary`)
* **Autenticação:** `X-DocuWare-Token` ou `Authorization: Bearer`

#### Exemplo de Chamada `curl`

```bash
curl -s -X GET "https://wp.processcloud.app/ai-gateway/train/summary" \
  -H "X-DocuWare-Token: <SEU_TOKEN_SECRETO_DOCUWARE>"
```

#### Campos Retornados (`/train/summary`)

| Bloco / Campo | Tipo | Descrição |
| :--- | :--- | :--- |
| `model.version` | `string \| null` | Versão do modelo ativo em vigor (ex.: `"v1.0.3"`) ou `null` quando ainda não há modelo ativo. |
| `model.status` | `string` | `"active"` (modelo validado em produção) ou `"not_ready"` (aguardando mínimo de 2 categorias com `>= 10` exemplos coerentes). |
| `model.engine` | `string` | Motor ML em uso (`"node_tfidf_logreg"` ou `"python_sklearn"`). |
| `model.trainedAt` | `string \| null` | Data/hora ISO 8601 da conclusão do treinamento do modelo ativo. |
| `model.activatedAt` | `string \| null` | Data/hora ISO 8601 da ativação do modelo ativo. |
| `model.validation` | `object \| null` | Métricas reais da validação cruzada 5-Fold (`accuracy`, `macroF1` e `weightedF1` ponderado pelo suporte de cada classe). |
| `summary.totalCategories` | `number` | Total de categorias documentais cadastradas. |
| `summary.activeCategories` | `number` | Quantidade de categorias ativas incorporadas no modelo atual. |
| `summary.pendingCategories` | `number` | Quantidade de categorias em `"pending_validation"`. |
| `summary.eligibleCategories` | `number` | Quantidade de categorias que já atingiram `>= 10` exemplos válidos. |
| `summary.totalExamples` | `number` | Total de documentos únicos válidos armazenados em disco. |
| `summary.learnedExamples` | `number` | Quantidade de exemplos incorporados na versão ativa do modelo. |
| `summary.pendingExamples` | `number` | Quantidade de exemplos válidos aguardando incorporação (`totalExamples - learnedExamples`). |
| `summary.totalTrainingJobs` | `number` | Total histórico de chamadas recebidas em `/train`. |
| `summary.completedJobs` | `number` | Trabalhos concluídos com sucesso (`stored` + `learned`). |
| `summary.pendingJobs` | `number` | Trabalhos atualmente na fila (`queued` + `processing`). |
| `summary.failedJobs` | `number` | Trabalhos com erro técnico (`failed`, ex.: `DOCUMENT_NOT_FOUND`). |
| `summary.rejectedJobs` | `number` | Trabalhos rejeitados por OCR insuficiente (`rejected`, `INSUFFICIENT_OCR_TEXT`). |
| `categories[].examplesIncludedInModel` | `number` | Quantidade de exemplos desta categoria incluídos no modelo ativo. |
| `categories[].pendingExamples` | `number` | Exemplos desta categoria ainda não incorporados no modelo ativo. |
| `categories[].validation` | `object \| null` | `{ precision, recall, f1 }` reais da categoria no 5-Fold CV (ou `null` se pendente). |
| `categories[].lastExampleAt` | `string \| null` | Data/hora ISO 8601 do último exemplo válido recebido na categoria. |
| `model.validation.confusionMatrix` | `object` | Matriz de confusão K×K da validação cruzada (`labels`, `matrix`): linhas = classe real, colunas = classe prevista. A soma total é igual ao número de exemplos avaliados. |
| `trainingDiagnostics` | `object` | Diagnóstico persistido da **última tentativa** de treino (aprovada ou rejeitada): `lastAttemptAt`, `candidateCategories`, `candidateExamples`, `candidateValidation` (`accuracy`, `macroF1`, `weightedF1`, `perCategory`, `confusionMatrix`), `activationApproved`, `rejectionReasons`, `activeModelVersionBeforeAttempt`, `activeModelVersionAfterAttempt`. |
| `categories[].activation` | `object` | Motivo do estado da categoria: `eligible`, `includedInLastCandidate`, `lastAttemptStatus` (`approved`, `rejected`, `pending`, `not_evaluated`), `reasonCode`, `reasonMessage`, `candidatePrecision`, `candidateRecall`, `candidateF1`, `requiredF1`. |

> [!NOTE]
> **Distinção entre `completedJobs` e `learnedExamples`:**
> - `summary.completedJobs`: total de chamadas a `/train` cujo processamento do documento e extração de Textshot foram concluídos com sucesso (`stored` ou `learned`).
> - `summary.learnedExamples`: quantidade de documentos que foram **efetivamente aprendidos e incorporados** na versão ativa do modelo discriminativo.
> - Se uma categoria já recebeu documentos mas ainda está pendente de validação discriminativa, os seus trabalhos estarão em `completedJobs` (`stored`), mas os seus exemplos só contarão em `learnedExamples` após validação e ativação da versão do modelo.

#### Códigos `categories[].activation.reasonCode`

| Código | Significado |
| :--- | :--- |
| `VALIDATED_AND_ACTIVE` | Categoria aprovada na validação cruzada e ativa no modelo. |
| `INSUFFICIENT_EXAMPLES` | Menos de `CLASSIFIER_MIN_EXAMPLES_PER_CATEGORY` exemplos válidos. |
| `INSUFFICIENT_ELIGIBLE_CATEGORIES` | Existem menos de 2 categorias elegíveis para treino discriminativo. |
| `CATEGORY_F1_BELOW_THRESHOLD` | F1 da categoria no candidato abaixo de `CLASSIFIER_MIN_VALIDATION_F1`. |
| `MACRO_F1_BELOW_THRESHOLD` | Macro-F1 global do candidato abaixo do mínimo. |
| `MODEL_REGRESSION_PREVENTED` | Candidato com as mesmas categorias degradou o Macro-F1 acima de `CLASSIFIER_MAX_REGRESSION_DROP`. |
| `CANDIDATE_MODEL_REJECTED` | Categoria aprovada individualmente, mas o modelo candidato não foi ativado. |
| `PENDING_TRAINING_CYCLE` | Categoria elegível ainda não avaliada (ciclo agendado). |

#### Regras de validação e ativação

* O candidato é treinado com **todas** as categorias elegíveis. Cada categoria exige `F1 >= 0.75` e o Macro-F1 global `>= 0.75`.
* A proteção contra regressão (`CLASSIFIER_MAX_REGRESSION_DROP`) só compara modelos com **o mesmo conjunto de categorias**; a expansão de 2 para 4 categorias não é bloqueada comparando Macro-F1 de cardinalidades diferentes.
* Validação cruzada **5-Fold estratificada por grupo** (documentos com o mesmo `textHash` ficam no mesmo fold); vocabulário e IDF são construídos **apenas com o fold de treino** (sem *data leakage*).
* A matriz de confusão regista sempre a classe prevista (top-1). Casos com baixa confiança/margem são contabilizados separadamente em `manualReviewRate` e não geram falsos negativos "fantasma".
* Se uma categoria reprovar, as restantes aprovadas só originam nova versão se o modelo ativo ainda não as contiver totalmente aprendidas (evita inflação de versões).
* No arranque, se existirem categorias elegíveis não avaliadas para o conjunto atual de dados ou métricas legadas inconsistentes, o serviço reavalia automaticamente o modelo **sem apagar exemplos nem histórico**.

#### Exemplo de Resposta (`HTTP 200 OK`)

```json
{
  "success": true,
  "model": {
    "version": "v1.0.6",
    "status": "active",
    "engine": "node_tfidf_logreg",
    "trainedAt": "2026-11-03T11:00:00.000Z",
    "activatedAt": "2026-11-03T11:00:02.000Z",
    "validation": {
      "accuracy": 0.9677,
      "macroF1": 0.9682,
      "weightedF1": 0.9685,
      "confusionMatrix": {
        "labels": [
          "Factura",
          "Factura Adiantamento",
          "Factura Global",
          "Ficha de Intervenção"
        ],
        "matrix": [
          [20, 0, 0, 0],
          [0, 16, 0, 0],
          [0, 0, 12, 0],
          [0, 0, 0, 14]
        ]
      }
    }
  },
  "summary": {
    "totalCategories": 4,
    "activeCategories": 4,
    "pendingCategories": 0,
    "eligibleCategories": 4,
    "totalExamples": 62,
    "learnedExamples": 62,
    "pendingExamples": 0,
    "totalTrainingJobs": 62,
    "completedJobs": 62,
    "pendingJobs": 0,
    "failedJobs": 0,
    "rejectedJobs": 0
  },
  "trainingDiagnostics": {
    "lastAttemptAt": "2026-11-03T11:00:00.000Z",
    "candidateCategories": [
      "Factura",
      "Factura Adiantamento",
      "Factura Global",
      "Ficha de Intervenção"
    ],
    "candidateExamples": 62,
    "candidateValidation": {
      "accuracy": 0.9677,
      "macroF1": 0.9682,
      "weightedF1": 0.9685,
      "manualReviewRate": 0.0323,
      "perCategory": {
        "Factura": {
          "documentType": "Factura",
          "support": 20,
          "precision": 0.9524,
          "recall": 1.0,
          "f1": 0.9756,
          "passed": true
        },
        "Factura Adiantamento": {
          "documentType": "Factura Adiantamento",
          "support": 16,
          "precision": 1.0,
          "recall": 0.9375,
          "f1": 0.9677,
          "passed": true
        },
        "Factura Global": {
          "documentType": "Factura Global",
          "support": 12,
          "precision": 1.0,
          "recall": 1.0,
          "f1": 1.0,
          "passed": true
        },
        "Ficha de Intervenção": {
          "documentType": "Ficha de Intervenção",
          "support": 14,
          "precision": 1.0,
          "recall": 1.0,
          "f1": 1.0,
          "passed": true
        }
      },
      "confusionMatrix": {
        "labels": [
          "Factura",
          "Factura Adiantamento",
          "Factura Global",
          "Ficha de Intervenção"
        ],
        "matrix": [
          [20, 0, 0, 0],
          [0, 16, 0, 0],
          [0, 0, 12, 0],
          [0, 0, 0, 14]
        ]
      }
    },
    "activationApproved": true,
    "rejectionReasons": [],
    "activeModelVersionBeforeAttempt": "v1.0.5",
    "activeModelVersionAfterAttempt": "v1.0.6"
  },
  "categories": [
    {
      "documentType": "Factura",
      "status": "active",
      "examplesReceived": 20,
      "minimumExamples": 10,
      "examplesIncludedInModel": 20,
      "pendingExamples": 0,
      "active": true,
      "validation": {
        "precision": 0.9524,
        "recall": 1.0,
        "f1": 0.9756
      },
      "activation": {
        "eligible": true,
        "includedInLastCandidate": true,
        "lastAttemptStatus": "approved",
        "reasonCode": "VALIDATED_AND_ACTIVE",
        "reasonMessage": "Categoria validada com sucesso na validação cruzada 5-Fold (F1=0.9756 >= 0.75) e incorporada no modelo ativo v1.0.6.",
        "candidatePrecision": 0.9524,
        "candidateRecall": 1.0,
        "candidateF1": 0.9756,
        "requiredF1": 0.75
      },
      "lastExampleAt": "2026-11-03T10:45:00.000Z"
    },
    {
      "documentType": "Factura Adiantamento",
      "status": "active",
      "examplesReceived": 16,
      "minimumExamples": 10,
      "examplesIncludedInModel": 16,
      "pendingExamples": 0,
      "active": true,
      "validation": {
        "precision": 1.0,
        "recall": 0.9375,
        "f1": 0.9677
      },
      "activation": {
        "eligible": true,
        "includedInLastCandidate": true,
        "lastAttemptStatus": "approved",
        "reasonCode": "VALIDATED_AND_ACTIVE",
        "reasonMessage": "Categoria validada com sucesso na validação cruzada 5-Fold (F1=0.9677 >= 0.75) e incorporada no modelo ativo v1.0.6.",
        "candidatePrecision": 1.0,
        "candidateRecall": 0.9375,
        "candidateF1": 0.9677,
        "requiredF1": 0.75
      },
      "lastExampleAt": "2026-11-03T10:50:00.000Z"
    },
    {
      "documentType": "Factura Global",
      "status": "active",
      "examplesReceived": 12,
      "minimumExamples": 10,
      "examplesIncludedInModel": 12,
      "pendingExamples": 0,
      "active": true,
      "validation": {
        "precision": 1.0,
        "recall": 1.0,
        "f1": 1.0
      },
      "activation": {
        "eligible": true,
        "includedInLastCandidate": true,
        "lastAttemptStatus": "approved",
        "reasonCode": "VALIDATED_AND_ACTIVE",
        "reasonMessage": "Categoria validada com sucesso na validação cruzada 5-Fold (F1=1.0000 >= 0.75) e incorporada no modelo ativo v1.0.6.",
        "candidatePrecision": 1.0,
        "candidateRecall": 1.0,
        "candidateF1": 1.0,
        "requiredF1": 0.75
      },
      "lastExampleAt": "2026-11-03T10:52:00.000Z"
    },
    {
      "documentType": "Ficha de Intervenção",
      "status": "active",
      "examplesReceived": 14,
      "minimumExamples": 10,
      "examplesIncludedInModel": 14,
      "pendingExamples": 0,
      "active": true,
      "validation": {
        "precision": 1.0,
        "recall": 1.0,
        "f1": 1.0
      },
      "activation": {
        "eligible": true,
        "includedInLastCandidate": true,
        "lastAttemptStatus": "approved",
        "reasonCode": "VALIDATED_AND_ACTIVE",
        "reasonMessage": "Categoria validada com sucesso na validação cruzada 5-Fold (F1=1.0000 >= 0.75) e incorporada no modelo ativo v1.0.6.",
        "candidatePrecision": 1.0,
        "candidateRecall": 1.0,
        "candidateF1": 1.0,
        "requiredF1": 0.75
      },
      "lastExampleAt": "2026-11-03T10:40:00.000Z"
    }
  ]
}
```

---

### 4.5. Endpoint de Histórico de Treinamento — `GET /ai-gateway/train/history`

Lista os trabalhos de treinamento ordenados do mais recente para o mais antigo (`createdAt` decrescente), sem expor texto OCR bruto ou dados sensíveis, distinguindo explicitamente entre **novo documento válido (`new_example`)**, **reenvio idempotente (`idempotent_duplicate`)**, **correção supervisionada de rótulo (`label_correction`)**, **rejeição (`rejected`)** e **falha (`failed`)**.

* **Método:** `GET`
* **Rota:** `/ai-gateway/train/history` (aliases: `/train/history`, `/api/train/history`)

#### Parâmetros de Query Opcionais (`/train/history`)

| Parâmetro | Tipo | Descrição |
| :--- | :--- | :--- |
| `documentType` | `string` | Filtra por categoria documental (ex.: `Ficha de Intervenção`). |
| `status` | `string` | Filtra pelo estado do trabalho (`queued`, `processing`, `stored`, `learned`, `rejected`, `failed`). |
| `from` | `string` | Data/hora inicial ISO 8601 (ex.: `2026-11-01` ou `2026-11-01T00:00:00Z`). |
| `to` | `string` | Data/hora final ISO 8601 (ex.: `2026-11-03` ou `2026-11-03T23:59:59Z`). |
| `limit` | `number` | Quantidade de itens por página (padrão: `50`, máximo: `200`). |
| `cursor` | `string` | Cursor estável (`trainingId` retornado em `nextCursor` na página anterior). |

#### Tipos de Operação Registados (`operationType`)

| `operationType` | `isIdempotentDuplicate` | `wasCorrection` | Significado |
| :--- | :---: | :---: | :--- |
| `"new_example"` | `false` | `false` | Novo documento válido (`fileCabinetId + documentId` inédito) armazenado na categoria. |
| `"idempotent_duplicate"` | **`true`** | `false` | Reenvio do mesmo documento com a mesma categoria (idempotente; não inflaciona `examplesReceived`). |
| `"label_correction"` | `false` | **`true`** | Correção supervisionada de rótulo do mesmo documento para uma nova categoria (`previousDocumentType` preenchido). |
| `"rejected"` | `false` | `false` | Documento rejeitado por texto OCR insuficiente (`errorCode: "INSUFFICIENT_OCR_TEXT"`). |
| `"failed"` | `false` | `false` | Falha técnica ao recuperar o documento no DocuWare (ex.: `DOCUMENT_NOT_FOUND`). |
| `"pending"` | `false` | `false` | Trabalho ainda na fila (`queued` ou `processing`). |

#### Exemplos de Chamadas `curl` (`/train/history`)

```bash
# 1. Consultar os últimos 20 treinamentos
curl -s -X GET "https://wp.processcloud.app/ai-gateway/train/history?limit=20" \
  -H "X-DocuWare-Token: <SEU_TOKEN_SECRETO_DOCUWARE>"

# 2. Filtrar por categoria, estado e intervalo de datas
curl -s -G "https://wp.processcloud.app/ai-gateway/train/history" \
  -H "X-DocuWare-Token: <SEU_TOKEN_SECRETO_DOCUWARE>" \
  --data-urlencode "documentType=Ficha de Intervenção" \
  --data-urlencode "status=learned" \
  --data-urlencode "from=2026-11-01" \
  --data-urlencode "to=2026-11-03"

# 3. Avançar para a página seguinte usando o nextCursor
curl -s -X GET "https://wp.processcloud.app/ai-gateway/train/history?limit=20&cursor=trn-000031" \
  -H "X-DocuWare-Token: <SEU_TOKEN_SECRETO_DOCUWARE>"
```

#### Exemplo de Resposta (`HTTP 200 OK`)

```json
{
  "success": true,
  "totalMatching": 32,
  "count": 2,
  "limit": 2,
  "nextCursor": "trn-000031",
  "hasMore": true,
  "items": [
    {
      "trainingId": "trn-000032",
      "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
      "documentId": 1010186,
      "documentType": "Nota de Crédito",
      "status": "stored",
      "jobFinished": true,
      "operationType": "label_correction",
      "isIdempotentDuplicate": false,
      "includedInModel": false,
      "modelVersion": null,
      "wasCorrection": true,
      "previousDocumentType": "Fatura",
      "attempts": 1,
      "errorCode": null,
      "createdAt": "2026-11-03T01:55:00.000Z",
      "completedAt": "2026-11-03T01:55:01.000Z"
    },
    {
      "trainingId": "trn-000031",
      "fileCabinetId": "04a67f02-e6a0-4370-aa96-ea2546332cae",
      "documentId": 1010185,
      "documentType": "Ficha de Intervenção",
      "status": "learned",
      "jobFinished": true,
      "operationType": "new_example",
      "isIdempotentDuplicate": false,
      "includedInModel": true,
      "modelVersion": "v1.0.3",
      "wasCorrection": false,
      "previousDocumentType": null,
      "attempts": 1,
      "errorCode": null,
      "createdAt": "2026-11-03T01:50:00.000Z",
      "completedAt": "2026-11-03T01:50:02.000Z"
    }
  ]
}
```

---

### 4.6. Relatório dos 20 Cenários Obrigatórios de Aprendizagem, Monitoramento e Classificação

Validados automaticamente na suíte [`src/tests/classifier.test.ts`](src/tests/classifier.test.ts) durante cada build Docker:

| # | Cenário Obrigatório | Resultado Validado |
| :-: | :--- | :--- |
| **1** | Enviar um único documento para `/train` e consultar `/train/status` | Retorna `queued` imediato (`trn-000001`) e transita para `stored` (`jobFinished: true`) após extrair o Textshot. |
| **2** | Reenviar o mesmo documento (`fileCabinetId + documentId`) com o mesmo tipo | Idempotente: não duplica o exemplo nem inflaciona `examplesReceived`. |
| **3** | Reenviar o mesmo documento com tipo documental corrigido | `wasCorrection: true`, atualiza `previousDocumentType` e recalcula ambas as categorias. |
| **4** | Enviar 1 a 9 exemplos de uma nova categoria | Categoria permanece em `pending_validation` (`active: false`) e exemplos em `stored` (`jobFinished: true`). |
| **5** | Enviar o 10.º exemplo de uma categoria coerente (com `>= 2` categorias elegíveis) | Com 1 categoria elegível, aguarda em `stored`/`pending_validation`; ao atingir a 2.ª categoria com 10 exemplos coerentes, dispara treino e validação 5-Fold automáticos, passando ambas a `active` e os exemplos a `learned`. |
| **6** | Enviar 10 exemplos incoerentes/contraditórios de uma categoria | Reprova na validação cruzada (`F1 < 0.75`); categoria permanece em `pending_validation`. |
| **7** | Enviar exemplos provenientes de dois armários diferentes para a mesma categoria | Exemplos de `fc-glpi-001` e `fc-manut-002` consolidam a mesma categoria documental. |
| **8** | Classificar documento num terceiro armário (`fc-armario-terceiro-999`) | Classifica com sucesso usando o conhecimento adquirido nos outros armários. |
| **9** | Classificar documento claro de `"Ficha de Intervenção"` | `status: "classified"`, `documentType: "Ficha de Intervenção"`, `requiresManualReview: false`. |
| **10** | Classificar documento claro de `"Contrato"` | `status: "classified"`, `documentType: "Contrato"`, `requiresManualReview: false`. |
| **11** | Distinguir entre `"Fatura"`, `"Nota de Crédito"` e `"Fatura de Adiantamento"` | Classifica cada um dos 3 tipos financeiros separadamente com alta confiança. |
| **12** | Classificar documento ambíguo ou de categoria desconhecida (*Open-Set*) | Testado com texto curto/ambíguo e com documento de categoria desconhecida (`"Guia de Remessa Logística"`): retorna `status: "needs_review"`, `documentType: null`, `requiresManualReview: true`. |
| **13** | Classificar documento sem Textshot disponível | Retorna `422 TEXTSHOT_NOT_AVAILABLE` estruturado. |
| **14** | Classificar documento inexistente no DocuWare | Retorna `404 DOCUMENT_NOT_FOUND` estruturado. |
| **15** | Simular reinício do serviço com trabalhos `processing` na fila | `recoverAndResumeQueue()` recupera os trabalhos do disco (`/app/data`) e conclui a aprendizagem. |
| **16** | Confirmar que `/extract` e `/textshot` (incluindo excerto de 2.000 chars) continuam operacionais | Ambos os contratos e rotas funcionam sem qualquer regressão. |
| **17** | Consultar `/train/summary` e `/train/history` com filtros e paginação estável por cursor | Retorna métricas reais (`accuracy`, `macroF1`, `weightedF1`), contagens por categoria e histórico distinguindo `new_example`, `idempotent_duplicate`, `label_correction`, `rejected` e `failed`. |
| **18** | Cenário real de produção com 4 categorias elegíveis (Factura=20, Factura Adiantamento=16, Factura Global=12, Ficha de Intervenção=14 → 62 exemplos) | As 4 categorias são validadas e ativadas em conjunto; `sum(confusionMatrix) = 62`, somas das linhas = `support`, e `precision`/`recall`/`f1`/`accuracy`/`macroF1`/`weightedF1` recalculados a partir da matriz coincidem exatamente com os valores reportados. |
| **19** | Categoria elegível com F1 insuficiente | Modelo ativo mantém-se (`v1.0.1`, sem inflação de versão); `trainingDiagnostics.rejectionReasons` e `categories[].activation` (`CATEGORY_F1_BELOW_THRESHOLD`, `candidateF1 < 0.75`) persistidos e recuperados após reinício. |
| **20** | Arranque sobre estado persistido com categorias elegíveis não aprendidas / métricas legadas | `recoverAndResumeQueue()` dispara reavaliação automática, ativa todas as categorias elegíveis e marca os exemplos como `learned`, sem apagar dados. |

---

## 5. Configuração de Variáveis de Ambiente na VPS (`.env`)

No arquivo `/app/middleware-ia-docuware/.env` da VPS Contabo (veja modelo em [`.env.example`](.env.example)):

```env
PORT=3014
HOST=0.0.0.0
NODE_ENV=production

# Token de proteção do Gateway (enviado pelo DocuWare no header X-DocuWare-Token)
API_AUTH_TOKEN=<SEU_TOKEN_SECRETO_DOCUWARE>

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
CLASSIFIER_MIN_CATEGORIES_FOR_MODEL=2
CLASSIFIER_MIN_TEXT_CHARS=30
CLASSIFIER_MAX_FEATURE_CHARS=15000
CLASSIFIER_MAX_FEATURE_PAGES=5
CLASSIFIER_MIN_CONFIDENCE=0.70
CLASSIFIER_MIN_MARGIN=0.15
CLASSIFIER_MIN_VALIDATION_F1=0.75
CLASSIFIER_MAX_REGRESSION_DROP=0.05
CLASSIFIER_MAX_JOB_ATTEMPTS=3
CLASSIFIER_JOB_RETRY_DELAY_MS=500
CLASSIFIER_WORKER_CONCURRENCY=2
CLASSIFIER_USE_PYTHON_ENGINE=false

MAX_FILE_SIZE=31457280
```

---

## 6. Estrutura do Projeto e Deploy Contínuo (CI/CD)

```text
.
├── .github/workflows/
│   └── deploy.yml             # Pipeline CI/CD GitHub Actions (deploy automático via SSH na Contabo)
├── ml/
│   └── classifier_engine.py   # Script Python opcional (desativado por padrão; usa motor determinístico nativo)
├── scripts/
│   └── configure-nginx.sh     # Script idempotente que configura /ai-gateway/ no portal_nginx
├── src/
│   ├── server.ts              # Inicialização Fastify e registro das rotas (/health, /extract, /textshot, /train, /classify)
│   ├── config.ts              # Configurações tipadas lidas de variáveis de ambiente (.env)
│   ├── types.ts               # Contratos TypeScript para /extract, /textshot, /train, /train/status, /train/summary, /train/history e /classify
│   ├── auth.ts                # Autenticação time-safe (X-DocuWare-Token ou Authorization: Bearer)
│   ├── docuware-client.ts     # Cliente DocuWare Platform API (cache de sessão, seções, Textshot e truncamento)
│   ├── ml-engine.ts           # Motor ML determinístico nativo (TF-IDF 1..2 + LogReg Multinomial + 5-Fold CV + Calibração Multiplicativa)
│   ├── classifier-store.ts    # Persistência transacional em disco (categorias, exemplos, fila, modelos e auditoria)
│   ├── classifier-service.ts  # Fila assíncrona, deduplicação, correção supervisionada, monitoramento (/summary, /history), treino e classificação
│   ├── schema-builder.ts      # Validador de contrato JSON, JSON Schema dinâmico e filtro estrito de saída
│   ├── openai-service.ts      # Dispatcher multi-provider (OpenAI / Gemini / Compatible) com retry exponencial
│   ├── routes/
│   │   ├── extract.ts         # Endpoints POST (/ai-gateway/extract, /extract, /api/extract, /)
│   │   ├── textshot.ts        # Endpoints POST (/ai-gateway/textshot, /textshot, /api/textshot)
│   │   ├── classifier.ts      # Endpoints POST /train, GET /train/status, GET /train/summary, GET /train/history e POST /classify
│   │   └── health.ts          # Endpoints GET (/ai-gateway/health, /health)
│   └── tests/
│       ├── gateway.test.ts    # Testes unitários e de aceitação do endpoint /extract (3 execuções no mesmo PDF)
│       ├── textshot.test.ts   # Testes automatizados dos 6 cenários obrigatórios do endpoint /textshot
│       └── classifier.test.ts # Testes automatizados dos 17 cenários obrigatórios de aprendizagem, monitoramento e classificação
├── tests/
│   └── curl-examples.sh       # Exemplos executáveis de chamadas curl
├── Dockerfile                 # Multi-Stage Node 22 Alpine (compila TypeScript, executa testes e gera imagem de produção)
├── docker-compose.yml         # Configuração de produção na VPS Contabo (127.0.0.1:3014 e volume persistente /app/data)
├── .env.example
├── package.json
└── tsconfig.json
```

Todo `git push` na branch `main` dispara automaticamente o workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), que:
1. Conecta via SSH na VPS Contabo e atualiza `/app/middleware-ia-docuware` preservando o `.env`.
2. Compila o TypeScript e executa os testes automatizados (`gateway.test.ts`, `textshot.test.ts` e `classifier.test.ts`) durante o `docker compose build`.
3. Recria o container `docuware-ai-gateway`, garante a rota `/ai-gateway/` no `portal_nginx` e valida o `/health`.

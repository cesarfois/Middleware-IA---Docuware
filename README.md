# Gateway Universal de Inteligência Documental (DocuWare Cloud 7.14 ↔ OpenAI GPT-4o)

Microserviço containerizado em **Node.js (TypeScript + Fastify)** projetado para operar como **Gateway Universal de Extração Documental** para o **DocuWare Cloud 7.14**.

Com esta arquitetura orientada a metadados, você mantém **um único endpoint na VPS** (`POST /extract`) e define dinamicamente o que extrair e quais campos JSON retornar diretamente no editor **HTTP Body** de cada atividade de Workflow no DocuWare.

---

## 1. Arquitetura e Mecânica do Multipart no DocuWare 7.14

Quando uma atividade **Web Service (REST)** no DocuWare Workflow Designer está configurada com **[x] Anexar documento (Attach document)** e conteúdo no **HTTP Body**:
1. O DocuWare empacota o binário do PDF no campo multipart `file`.
2. O conteúdo textual escrito no **HTTP Body** é enviado no campo multipart `requestData`.
3. O Gateway lê `file` em memória (sem gravar nada em disco), interpreta o JSON ou texto plano de `requestData`, constrói dinamicamente o **Structured Outputs (`json_schema` com `strict: true`)** da OpenAI e retorna o JSON plano na raiz da resposta HTTP `200 OK` para mapeamento direto nos campos de índice do DocuWare.

---

## 2. Estrutura do Projeto

```text
.
├── src/
│   ├── server.ts            # Inicialização Fastify, limites multipart, handler global e graceful shutdown
│   ├── config.ts            # Leitura e validação tipada de variáveis de ambiente (.env)
│   ├── types.ts             # Interfaces TypeScript do contrato DocuWare <-> OpenAI
│   ├── auth.ts              # Autenticação time-safe (X-DocuWare-Token ou Authorization: Bearer)
│   ├── schema-builder.ts    # Parser resiliente de requestData e gerador de JSON Schema (strict: true)
│   ├── openai-service.ts    # Cliente OpenAI GPT-4o multimodal (PDF Base64) + Retry com Backoff Exponencial
│   └── routes/
│       ├── extract.ts       # Endpoint POST /extract (e aliases /api/extract e /)
│       └── health.ts        # Endpoint GET /health para monitoramento Docker/Reverse Proxy
├── tests/
│   └── curl-examples.sh     # Exemplos prontos de chamadas curl (Cenários A, B, C e Texto Plano)
├── Dockerfile               # Build Multi-Stage Node 22 Alpine (execução segura sob usuário não-root)
├── docker-compose.yml       # Deploy pronto para produção na VPS com reverse-proxy-network
├── .env.example             # Modelo de variáveis de ambiente
├── package.json
└── tsconfig.json
```

---

## 3. Deploy na VPS com Docker Compose

1. Crie a rede externa do Reverse Proxy (caso ainda não exista na sua VPS com Traefik ou Nginx Proxy Manager):
   ```bash
   docker network create reverse-proxy-network
   ```

2. Copie o arquivo `.env.example` para `.env` e preencha suas chaves:
   ```bash
   cp .env.example .env
   ```

3. Suba o serviço em background:
   ```bash
   docker compose up -d --build
   ```

4. Verifique a saúde do container:
   ```bash
   curl http://localhost:3000/health
   ```
   Resposta esperada:
   ```json
   {
     "status": "UP",
     "service": "docuware-ai-gateway",
     "model": "gpt-4o",
     "maxFileSizeMb": 30,
     "timestamp": "2026-11-02T00:00:00.000Z"
   }
   ```

---

## 4. Exemplos de Testes com `curl` (Cenários de Negócio)

Substitua `SEU_TOKEN_AQUI` pelo valor configurado em `API_AUTH_TOKEN` no seu `.env` e `./documento.pdf` pelo caminho de um arquivo PDF real.

### Cenário A: Contrato (Extraindo Partes, Vigência, Valor e Foro)

```bash
curl -X POST "http://localhost:3000/extract" \
  -H "X-DocuWare-Token: SEU_TOKEN_AQUI" \
  -F "file=@./contrato.pdf;type=application/pdf" \
  -F 'requestData={
    "system_instruction": "Você é um auditor jurídico especialista em análise de contratos corporativos.",
    "prompt": "Identifique as partes contratantes, CNPJ/NIF se houver, a data de início de vigência, o valor total acordado e o foro de eleição.",
    "schema": {
      "Contratante": "Razão social completa da parte contratante",
      "CNPJ_Contratante": "CNPJ ou NIF da contratante",
      "Contratada": "Razão social completa da prestadora/contratada",
      "CNPJ_Contratada": "CNPJ ou NIF da contratada",
      "Vigencia_Inicio": "Data de início da vigência no formato dd/MM/yyyy",
      "Vigencia_Fim": "Data de término da vigência no formato dd/MM/yyyy ou Indeterminado",
      "Valor_Total": "Valor global numérico formatado (ex: 15000.00)",
      "Foro": "Cidade/Comarca eleita para dirimir dúvidas"
    }
  }'
```

**Exemplo de Resposta HTTP 200 OK:**
```json
{
  "Contratante": "Alfa Indústria e Comércio Ltda",
  "CNPJ_Contratante": "12.345.678/0001-90",
  "Contratada": "Beta Soluções em Tecnologia S.A.",
  "CNPJ_Contratada": "98.765.432/0001-10",
  "Vigencia_Inicio": "01/11/2026",
  "Vigencia_Fim": "31/10/2027",
  "Valor_Total": "48000.00",
  "Foro": "São Paulo/SP"
}
```

---

### Cenário B: Fatura / Nota Fiscal (Extraindo Número, Data, Total e Itens)

> O construtor dinâmico de schema suporta tanto campos planos (`"string"`) quanto listas de objetos (`[{ ... }]`) para tabelas de itens!

```bash
curl -X POST "http://localhost:3000/extract" \
  -H "Authorization: Bearer SEU_TOKEN_AQUI" \
  -F "file=@./fatura.pdf;type=application/pdf" \
  -F 'requestData={
    "system_instruction": "Você é um analista fiscal sênior responsável pela conferência e lançamento de faturas e notas fiscais.",
    "prompt": "Extraia os dados de cabeçalho da fatura/nota fiscal, os totais de impostos e a lista detalhada de itens faturados.",
    "schema": {
      "Numero_Fatura": "Número da fatura ou nota fiscal",
      "Data_Emissao": "Data de emissão no formato dd/MM/yyyy",
      "Data_Vencimento": "Data de vencimento no formato dd/MM/yyyy",
      "Emitente_Nome": "Razão social do fornecedor/emitente",
      "Emitente_Documento": "CNPJ ou NIF do emitente",
      "Valor_Liquido": "Valor líquido total em formato decimal (ex: 1250.50)",
      "Valor_Impostos": "Total de impostos retidos ou destacados (ex: 185.00)",
      "Valor_Total": "Valor total da fatura (ex: 1435.50)",
      "Itens_Resumo": "Resumo concatenado dos itens separados por ponto e vírgula para indexação rápida",
      "Itens": [
        {
          "Codigo": "Código do produto ou serviço",
          "Descricao": "Descrição do item",
          "Quantidade": "Quantidade faturada",
          "Valor_Unitario": "Valor unitário",
          "Valor_Total_Item": "Subtotal do item"
        }
      ]
    }
  }'
```

---

### Cenário C: Ficha de Intervenção Técnica ou Formulário Manuscrito

```bash
curl -X POST "http://localhost:3000/extract" \
  -H "X-DocuWare-Token: SEU_TOKEN_AQUI" \
  -F "file=@./ficha_intervencao.pdf;type=application/pdf" \
  -F 'requestData={
    "system_instruction": "Você é um especialista em OCR de documentos de campo e leitura de caligrafia manuscrita em fichas técnicas de manutenção.",
    "prompt": "Leia cuidadosamente os campos impressos e manuscritos desta ficha de intervenção. Identifique o cliente, técnico responsável, horários, peças aplicadas, diagnóstico manuscrito e se o documento possui assinatura.",
    "schema": {
      "Numero_OS": "Número da Ordem de Serviço ou Ficha",
      "Data_Intervencao": "Data do atendimento no formato dd/MM/yyyy",
      "Cliente": "Nome do cliente atendido",
      "Equipamento_Serie": "Modelo ou número de série do equipamento",
      "Tecnico_Responsavel": "Nome do técnico que executou o serviço",
      "Relatorio_Manuscrito": "Transcrição fiel das observações manuscritas sobre o defeito e solução aplicada",
      "Pecas_Substituidas": "Lista de peças utilizadas ou substituídas",
      "Status_Final": "Concluído, Pendente de Peça ou Em Aberto",
      "Assinado_Cliente": "SIM ou NAO indicando se há assinatura manuscrita no campo do cliente"
    }
  }'
```

---

### Cenário D: Texto Plano Simples (Sem Schema JSON explícito)

Se você escrever apenas uma frase simples no **HTTP Body** do DocuWare, o Gateway ativa automaticamente o modo `json_object` e deduz as chaves do seu texto:

```bash
curl -X POST "http://localhost:3000/extract" \
  -H "X-DocuWare-Token: SEU_TOKEN_AQUI" \
  -F "file=@./guia_remessa.pdf;type=application/pdf" \
  -F 'requestData=Extraia o Numero_Guia, Data_Expedicao, Transportadora, Placa_Veiculo e Peso_Total_Kg deste documento.'
```


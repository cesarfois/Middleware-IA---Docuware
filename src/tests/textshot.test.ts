import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DocuWarePlatformClient,
  DocuWareServiceError,
  extractPageContentFromDocuWarePayload,
  truncateTextWordSafe,
  validateAndNormalizeTextshotRequest,
} from '../docuware-client.js';
import { config } from '../config.js';

describe('Endpoint Textshot — Validação e Truncamento Word-Safe', () => {
  it('deve validar fileCabinetId e documentId obrigatórios e rejeitar inválidos com INVALID_REQUEST', () => {
    assert.throws(
      () => validateAndNormalizeTextshotRequest({}),
      (err: unknown) =>
        err instanceof DocuWareServiceError && err.code === 'INVALID_REQUEST'
    );

    assert.throws(
      () =>
        validateAndNormalizeTextshotRequest({
          fileCabinetId: '../traversal',
          documentId: 123,
        }),
      (err: unknown) =>
        err instanceof DocuWareServiceError && err.code === 'INVALID_REQUEST'
    );

    const valid = validateAndNormalizeTextshotRequest({
      fileCabinetId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      documentId: 12345,
      options: {
        includePages: true,
        includeCoordinates: false,
        normalize: true,
        output: 'text',
        maxCharacters: 2000,
      },
    });

    assert.equal(valid.fileCabinetId, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    assert.equal(valid.documentId, 12345);
    assert.equal(valid.options.maxCharacters, 2000);
  });

  it('deve truncar respeitando maxCharacters sem cortar palavras ao meio e preservando Unicode', () => {
    const sample =
      'FICHA DE INTERVENÇÃO — Técnico: João Conceição — Substituição de fonte de alimentação';
    const result = truncateTextWordSafe(sample, 48);

    assert.equal(result.truncated, true);
    assert.equal(result.originalTextLength, sample.length);
    assert.ok(result.text.length <= 48);
    assert.equal(
      result.text,
      'FICHA DE INTERVENÇÃO — Técnico: João Conceição —'
    );
  });

  it('deve extrair texto e coordenadas reais de payload hierárquico do DocuWare sem inventar coordenadas', () => {
    const mockDocuWarePage = {
      PageNumber: 1,
      Zones: [
        {
          Paragraphs: [
            {
              Lines: [
                {
                  Words: [
                    { Value: 'FICHA', L: 120, T: 80, W: 95, H: 22 },
                    { Value: 'GLPI', L: 225, T: 80, W: 70, H: 22 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const parsed = extractPageContentFromDocuWarePayload(
      mockDocuWarePage,
      true
    );
    assert.equal(parsed.text, 'FICHA GLPI');
    assert.equal(parsed.coordinatesAvailable, true);
    assert.equal(parsed.elements.length, 2);
    assert.deepEqual(parsed.elements[0], {
      text: 'FICHA',
      left: 120,
      top: 80,
      width: 95,
      height: 22,
    });
  });
});

describe('Endpoint Textshot — 6 Cenários de Teste Obrigatórios (DocuWare Cloud 7.14)', () => {
  // Configura token de teste em memória
  config.docuwareBearerToken = 'test_dw_platform_bearer_token';
  const CABINET_ID = 'b7e3f1a0-91c2-4d5e-8a1b-001122334455';

  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);

    // Cenário 1: Documento 1001 — Ficha GLPI 1 página (impresso + manuscrito) com coordenadas
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Documents/1001`)) {
      return new Response(
        JSON.stringify({
          Id: 1001,
          Sections: [{ Id: 'sec-1001-a', PageCount: 1 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Sections/sec-1001-a/Textshot`)) {
      return new Response(
        JSON.stringify({
          Pages: [
            {
              PageNumber: 1,
              Lines: [
                {
                  Words: [
                    { Value: 'FICHA', L: 50, T: 40, W: 60, H: 18 },
                    { Value: 'DE', L: 115, T: 40, W: 25, H: 18 },
                    { Value: 'INTERVENÇÃO', L: 145, T: 40, W: 130, H: 18 },
                  ],
                },
                {
                  Words: [
                    { Value: 'Ticket:', L: 50, T: 70, W: 55, H: 16 },
                    { Value: '813101-1083743', L: 110, T: 70, W: 120, H: 16 },
                    { Value: 'Cliente:', L: 250, T: 70, W: 60, H: 16 },
                    { Value: 'PUMA_24_Z1_5aAVENIDA', L: 315, T: 70, W: 180, H: 16 },
                  ],
                },
                {
                  Words: [
                    {
                      Value:
                        'Observação manuscrita: Remoção do TPA da bomba 3/4 Terminal tampered - Peça Af 0135335',
                      L: 50,
                      T: 420,
                      W: 480,
                      H: 45,
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // Cenário 2: Documento 1002 — Ficha GLPI 2 páginas (incluindo fotografia na pág 2)
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Documents/1002`)) {
      return new Response(
        JSON.stringify({
          Id: 1002,
          Sections: [{ Id: 'sec-1002-main', PageCount: 2 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Sections/sec-1002-main/Textshot`)) {
      return new Response(
        JSON.stringify({
          Pages: [
            {
              PageNumber: 1,
              Lines: [
                {
                  Words: [
                    {
                      Value:
                        'FICHA DE INTERVENÇÃO GLPI - Ticket Nº: 962759-1310691 - Técnico: Cudivila Fernando',
                      L: 40,
                      T: 50,
                      W: 450,
                      H: 20,
                    },
                  ],
                },
              ],
            },
            {
              PageNumber: 2,
              Lines: [
                {
                  Words: [
                    {
                      Value:
                        'ANEXO FOTOGRÁFICO DO EQUIPAMENTO - S/N: 3335 - Spectra T300 Wifi',
                      L: 40,
                      T: 600,
                      W: 420,
                      H: 18,
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // Cenário 3: Documento 1003 — Contrato BPC com 56 páginas
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Documents/1003`)) {
      return new Response(
        JSON.stringify({
          Id: 1003,
          Sections: [{ Id: 'sec-1003-bpc-56', PageCount: 56 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Sections/sec-1003-bpc-56/Textshot`)) {
      const pages = Array.from({ length: 56 }, (_, idx) => ({
        PageNumber: idx + 1,
        Lines: [
          {
            Words: [
              {
                Value: `CONTRATO BPC - Cláusula e disposições contratuais da página ${idx + 1} de 56.`,
                L: 60,
                T: 80,
                W: 480,
                H: 16,
              },
            ],
          },
        ],
      }));
      return new Response(JSON.stringify({ Pages: pages }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Cenário 4: Documento 1004 — Documento com Textshot ausente
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Documents/1004`)) {
      return new Response(
        JSON.stringify({
          Id: 1004,
          Sections: [{ Id: 'sec-1004-empty', PageCount: 1 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes(`/Sections/sec-1004-empty/Textshot`)) {
      return new Response(JSON.stringify({ Pages: [] }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Cenário 5: Documento 1005 — Documento com múltiplas seções (3 seções distintas)
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Documents/1005`)) {
      return new Response(
        JSON.stringify({
          Id: 1005,
          Sections: [
            { Id: 'sec-1005-capa', PageCount: 1 },
            { Id: 'sec-1005-corpo', PageCount: 2 },
            { Id: 'sec-1005-laudo', PageCount: 1 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Sections/sec-1005-capa/Textshot`)) {
      return new Response(
        JSON.stringify({
          Pages: [{ PageNumber: 1, Value: 'SEÇÃO 1: CAPA DO PROCESSO' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Sections/sec-1005-corpo/Textshot`)) {
      return new Response(
        JSON.stringify({
          Pages: [
            { PageNumber: 1, Value: 'SEÇÃO 2: CORPO PÁGINA 1' },
            { PageNumber: 2, Value: 'SEÇÃO 2: CORPO PÁGINA 2' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Sections/sec-1005-laudo/Textshot`)) {
      return new Response(
        JSON.stringify({
          Pages: [{ PageNumber: 1, Value: 'SEÇÃO 3: LAUDO TÉCNICO FINAL' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    // Cenário 6: Documento 9999 — Documento inexistente (404)
    if (url.endsWith(`/FileCabinets/${CABINET_ID}/Documents/9999`)) {
      return new Response(JSON.stringify({ Message: 'Document not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  };

  const client = new DocuWarePlatformClient(mockFetch);

  it('Cenário 1: Ficha GLPI 1 página (impresso e manuscrito) + coordenadas', async () => {
    const req = validateAndNormalizeTextshotRequest({
      fileCabinetId: CABINET_ID,
      documentId: 1001,
      options: { includePages: true, includeCoordinates: true },
    });
    const res = await client.retrieveDocumentTextshot(req);

    assert.equal(res.success, true);
    assert.equal(res.sectionCount, 1);
    assert.equal(res.pageCount, 1);
    assert.ok(res.text.includes('813101-1083743'));
    assert.ok(res.text.includes('Terminal tampered'));
    assert.equal(res.pages?.[0].coordinatesAvailable, true);
    assert.ok((res.pages?.[0].elements?.length ?? 0) > 0);
  });

  it('Cenário 2: Ficha GLPI 2 páginas (incluindo fotografia) e reuso de sessão (authTimeMs = 0)', async () => {
    const req = validateAndNormalizeTextshotRequest({
      fileCabinetId: CABINET_ID,
      documentId: 1002,
      options: { includePages: true },
    });
    const res = await client.retrieveDocumentTextshot(req);

    assert.equal(res.pageCount, 2);
    assert.equal(res.timings.authTimeMs, 0); // Sessão reutilizada em cache
    assert.ok(res.text.includes('962759-1310691'));
    assert.ok(res.text.includes('ANEXO FOTOGRÁFICO DO EQUIPAMENTO'));
  });

  it('Cenário 3: Contrato BPC com 56 páginas preservando ordem estrita 1..56', async () => {
    const req = validateAndNormalizeTextshotRequest({
      fileCabinetId: CABINET_ID,
      documentId: 1003,
      options: { includePages: true },
    });
    const res = await client.retrieveDocumentTextshot(req);

    assert.equal(res.pageCount, 56);
    assert.equal(res.pages?.length, 56);
    assert.equal(res.pages?.[0].pageNumber, 1);
    assert.equal(res.pages?.[55].pageNumber, 56);
    assert.ok(res.text.includes('página 1 de 56'));
    assert.ok(res.text.includes('página 56 de 56'));
  });

  it('Cenário 4: Documento com Textshot ausente deve falhar com TEXTSHOT_NOT_AVAILABLE', async () => {
    const req = validateAndNormalizeTextshotRequest({
      fileCabinetId: CABINET_ID,
      documentId: 1004,
    });

    await assert.rejects(
      () => client.retrieveDocumentTextshot(req),
      (err: unknown) =>
        err instanceof DocuWareServiceError &&
        err.code === 'TEXTSHOT_NOT_AVAILABLE' &&
        err.statusCode === 422
    );
  });

  it('Cenário 5: Documento com múltiplas seções (3 seções, 4 páginas totais) na ordem exata', async () => {
    const req = validateAndNormalizeTextshotRequest({
      fileCabinetId: CABINET_ID,
      documentId: 1005,
      options: { includePages: true },
    });
    const res = await client.retrieveDocumentTextshot(req);

    assert.equal(res.sectionCount, 3);
    assert.equal(res.pageCount, 4);
    assert.deepEqual(
      res.pages?.map((p) => p.globalPageNumber),
      [1, 2, 3, 4]
    );
    assert.ok(res.text.startsWith('SEÇÃO 1: CAPA DO PROCESSO'));
    assert.ok(res.text.endsWith('SEÇÃO 3: LAUDO TÉCNICO FINAL'));
  });

  it('Cenário 6: Documento inexistente deve retornar DOCUMENT_NOT_FOUND (404)', async () => {
    const req = validateAndNormalizeTextshotRequest({
      fileCabinetId: CABINET_ID,
      documentId: 9999,
    });

    await assert.rejects(
      () => client.retrieveDocumentTextshot(req),
      (err: unknown) =>
        err instanceof DocuWareServiceError &&
        err.code === 'DOCUMENT_NOT_FOUND' &&
        err.statusCode === 404
    );
  });
});

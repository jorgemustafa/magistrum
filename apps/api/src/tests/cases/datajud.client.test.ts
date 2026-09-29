import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DataJudCaseNotFoundError,
  fetchDataJudCase,
} from "../../modules/cases/datajud.client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DATAJUD_API_KEY;
});

describe("DataJud client", () => {
  it.each([
    ["50012731720264036104", "trf3"],
    ["00000012320268130000", "tjmg"],
  ])("finds CNJ %s in the %s court index", async (cnjNumber, courtCode) => {
    process.env.DATAJUD_API_KEY = "key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: {
          hits: [
            {
              _source: {
                numeroProcesso: cnjNumber,
                tribunal: courtCode.toUpperCase(),
              },
            },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchDataJudCase({ cnjNumber, courtCode }),
    ).resolves.toMatchObject({
      cnjNumber,
      court: courtCode.toUpperCase(),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api-publica.datajud.cnj.jus.br/api_publica_${courtCode}/_search`,
      expect.objectContaining({
        body: JSON.stringify({
          size: 10,
          query: { match: { numeroProcesso: cnjNumber } },
        }),
      }),
    );
  });

  it("accepts only an exact CNJ match from search results", async () => {
    process.env.DATAJUD_API_KEY = "key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          hits: {
            hits: [
              { _source: { numeroProcesso: "50012731720264036105" } },
              { _source: { numeroProcesso: "50012731720264036104" } },
            ],
          },
        }),
      }),
    );

    await expect(
      fetchDataJudCase({
        cnjNumber: "50012731720264036104",
        courtCode: "trf3",
      }),
    ).resolves.toMatchObject({ cnjNumber: "50012731720264036104" });

    await expect(
      fetchDataJudCase({
        cnjNumber: "50012731720264036106",
        courtCode: "trf3",
      }),
    ).rejects.toBeInstanceOf(DataJudCaseNotFoundError);
  });

  it("uses only the process class as imported title", async () => {
    process.env.DATAJUD_API_KEY = "key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          hits: {
            hits: [
              {
                _source: {
                  numeroProcesso: "00003962420188260041",
                  classe: { nome: "Execução da Pena" },
                },
              },
            ],
          },
        }),
      }),
    );

    await expect(
      fetchDataJudCase({
        cnjNumber: "00003962420188260041",
        courtCode: "tjsp",
      }),
    ).resolves.toMatchObject({
      title: "Execução da Pena",
    });
  });
});

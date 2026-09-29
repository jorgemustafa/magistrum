import { createHash } from "node:crypto";
import type { PreviewCaseImportInput } from "./case-import.schemas.js";
import type {
  ImportedCaseDraft,
  ImportedMovement,
} from "./case-import.service.js";

type DataJudHit = {
  _source?: Record<string, unknown>;
};

type DataJudResponse = {
  hits?: {
    hits?: DataJudHit[];
  };
};

export class DataJudConfigError extends Error {
  constructor() {
    super("DATAJUD_API_KEY is not configured");
  }
}

export class DataJudCaseNotFoundError extends Error {
  constructor() {
    super("Case not found in DataJud");
  }
}

export class DataJudRequestError extends Error {
  constructor() {
    super("DataJud request failed");
  }
}

const endpointBase = "https://api-publica.datajud.cnj.jus.br";
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const date = (value: unknown) => {
  const parsed = text(value);
  if (!parsed) return null;
  const item = new Date(parsed);
  return Number.isNaN(item.getTime()) ? null : item;
};
const hash = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function firstName(value: unknown) {
  if (!Array.isArray(value)) return null;
  const first = value[0] as Record<string, unknown> | undefined;
  return text(first?.nome);
}

function nestedName(source: Record<string, unknown>, key: string) {
  const item = source[key] as Record<string, unknown> | undefined;
  return text(item?.nome);
}

function movementDescription(item: Record<string, unknown>) {
  const complements = item.complementosTabelados;
  if (!Array.isArray(complements) || complements.length === 0) return null;

  return complements
    .map((entry) => {
      const value = entry as Record<string, unknown>;
      return [text(value.nome), text(value.valor)].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join("; ");
}

function mapMovements(source: Record<string, unknown>): ImportedMovement[] {
  const movements = Array.isArray(source.movimentos) ? source.movimentos : [];

  return movements.flatMap((entry) => {
    const item = entry as Record<string, unknown>;
    const occurredAt = date(item.dataHora);
    const title =
      nestedName(item, "movimento") ?? text(item.nome) ?? text(item.codigo);
    if (!occurredAt || !title) return [];

    const externalId = [text(item.codigo), occurredAt.toISOString(), title]
      .filter(Boolean)
      .join("-");
    return {
      externalId,
      sourceHash: hash([
        "datajud",
        source.numeroProcesso,
        externalId,
        movementDescription(item),
      ]),
      type: "other",
      title,
      description: movementDescription(item),
      occurredAt,
    };
  });
}

function mapCase(
  source: Record<string, unknown>,
  courtCode: string,
): ImportedCaseDraft {
  const cnjNumber = text(source.numeroProcesso);
  if (!cnjNumber) throw new DataJudCaseNotFoundError();

  const caseClass = nestedName(source, "classe");
  const court = text(source.tribunal) ?? courtCode.toUpperCase();
  const division = nestedName(source, "orgaoJulgador");
  const subject = firstName(source.assuntos);

  return {
    cnjNumber,
    title: caseClass ?? cnjNumber,
    court,
    jurisdiction: null,
    division,
    description: subject,
    openedAt: date(source.dataAjuizamento),
    movements: mapMovements(source),
  };
}

export async function fetchDataJudCase(
  input: PreviewCaseImportInput,
): Promise<ImportedCaseDraft> {
  const apiKey = process.env.DATAJUD_API_KEY;
  if (!apiKey) throw new DataJudConfigError();

  const response = await fetch(
    `${endpointBase}/api_publica_${input.courtCode}/_search`,
    {
      method: "POST",
      headers: {
        Authorization: apiKey.startsWith("APIKey ")
          ? apiKey
          : `APIKey ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        size: 10,
        query: { match: { numeroProcesso: input.cnjNumber } },
      }),
    },
  );

  if (!response.ok) throw new DataJudRequestError();

  const body = (await response.json()) as DataJudResponse;
  const source = body.hits?.hits?.find(
    (hit) => hit._source?.numeroProcesso === input.cnjNumber,
  )?._source;
  if (!source) throw new DataJudCaseNotFoundError();

  return mapCase(source, input.courtCode);
}

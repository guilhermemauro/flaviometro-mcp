// Dados de campanha de 2026: TSE (dados abertos) + OpenCNPJ.
//
// O DivulgaCandContas do TSE bloqueia acesso automatizado, então usamos os
// arquivos do Portal de Dados Abertos (cdn.tse.jus.br):
//   - consulta_cand_2026.zip: cadastro dos candidatos, com o SQ_CANDIDATO
//   - CNPJ_campanha_2026.zip: CNPJ de campanha de cada candidato (sem sq!)
// O arquivo de CNPJs só traz a razão social "ELEICAO 2026 <NOME> <CARGO>",
// então o vínculo é feito pelo nome completo + cargo.
// Com o CNPJ, a API pública do OpenCNPJ devolve o cadastro na Receita Federal.

import { unzipSync } from "fflate";

import { baixar } from "./fonte.js";

const CDN = "https://cdn.tse.jus.br/estatistica/sead/odsele";
const URL_CANDIDATOS = `${CDN}/consulta_cand/consulta_cand_2026.zip`;
const URL_CNPJS = `${CDN}/prestacao_contas/CNPJ_campanha_2026.zip`;
const OPENCNPJ = (process.env.FLAVIOMETRO_OPENCNPJ_URL ?? "https://api.opencnpj.org").replace(/\/+$/, "");
const TTL_MS = Number(process.env.FLAVIOMETRO_TSE_CACHE_HORAS ?? 6) * 3_600_000;
const TIMEOUT_DOWNLOAD_MS = 120_000;

// Código da eleição usado nos links do DivulgaCandContas (eleições gerais 2026, 1º turno).
const ELEICAO_DIVULGA = "20322002026";

const REGIAO: Record<string, string> = Object.fromEntries(
  Object.entries({
    NORTE: ["AC", "AM", "AP", "PA", "RO", "RR", "TO"],
    NORDESTE: ["AL", "BA", "CE", "MA", "PB", "PE", "PI", "RN", "SE"],
    CENTROOESTE: ["DF", "GO", "MS", "MT"],
    SUDESTE: ["ES", "MG", "RJ", "SP"],
    SUL: ["PR", "RS", "SC"],
  }).flatMap(([regiao, ufs]) => ufs.map((uf) => [uf, regiao])),
);

/** Só os campos não sensíveis do cadastro. CPF, título e data de nascimento são descartados na leitura. */
export interface CandidatoTSE {
  sq: string;
  nome: string;
  nomeUrna: string;
  cargo: string;
  uf: string;
  ue: string;
  numero: string;
  partido: string;
  coligacao: string;
  composicaoColigacao: string;
  resultado: string;
  turno: string;
}

interface BaseTSE {
  candidatos: Map<string, CandidatoTSE>;
  /** razão social normalizada -> CNPJs */
  cnpjPorRazao: Map<string, string[]>;
  /** cargo normalizado -> [{ tokens do nome, cnpj, razão }] para o casamento aproximado */
  porCargo: Map<string, { tokens: string[]; cnpj: string; razao: string }[]>;
  geradoEm: string;
  carregadoEm: number;
}

let cache: BaseTSE | null = null;
let emAndamento: Promise<BaseTSE> | null = null;
const cacheCnpj = new Map<string, { dados: OpenCnpj; em: number }>();

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Divide uma linha CSV do TSE (separador ";", textos entre aspas, números sem aspas). */
function dividirCsv(linha: string): string[] {
  const campos: string[] = [];
  const re = /("((?:[^"]|"")*)"|[^;]*)(;|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(linha))) {
    campos.push(m[2] !== undefined ? m[2].replace(/""/g, '"') : m[1]);
    if (m[3] === "") break;
  }
  return campos;
}

async function baixarZip(url: string, arquivo: RegExp): Promise<string> {
  const buf = new Uint8Array(await (await baixar(url, TIMEOUT_DOWNLOAD_MS)).arrayBuffer());
  const arquivos = unzipSync(buf, { filter: (f) => arquivo.test(f.name) });
  const nome = Object.keys(arquivos)[0];
  if (!nome) throw new Error(`O zip ${url} não tem o arquivo esperado (${arquivo}). O TSE pode ter mudado o formato.`);
  return new TextDecoder("latin1").decode(arquivos[nome]);
}

async function carregar(): Promise<BaseTSE> {
  const [csv, txt] = await Promise.all([
    baixarZip(URL_CANDIDATOS, /_BRASIL\.csv$/i),
    baixarZip(URL_CNPJS, /cnpj_candidatos_\d+\.txt$/i),
  ]);

  const linhas = csv.split(/\r?\n/).filter(Boolean);
  const cab = dividirCsv(linhas[0]);
  const col = (nome: string) => {
    const i = cab.indexOf(nome);
    if (i < 0) throw new Error(`Coluna ${nome} ausente no CSV de candidatos do TSE.`);
    return i;
  };
  const c = {
    sq: col("SQ_CANDIDATO"),
    nome: col("NM_CANDIDATO"),
    urna: col("NM_URNA_CANDIDATO"),
    cargo: col("DS_CARGO"),
    uf: col("SG_UF"),
    ue: col("NM_UE"),
    numero: col("NR_CANDIDATO"),
    partido: col("SG_PARTIDO"),
    coligacao: col("NM_COLIGACAO"),
    composicao: col("DS_COMPOSICAO_COLIGACAO"),
    resultado: col("DS_SIT_TOT_TURNO"),
    turno: col("NR_TURNO"),
    geracao: col("DT_GERACAO"),
    hora: col("HH_GERACAO"),
  };

  const candidatos = new Map<string, CandidatoTSE>();
  let geradoEm = "";
  for (const linha of linhas.slice(1)) {
    const v = dividirCsv(linha);
    geradoEm ||= `${v[c.geracao]} ${v[c.hora]}`;
    const anterior = candidatos.get(v[c.sq]);
    // Candidatos do 2º turno aparecem duas vezes; fica a linha do turno mais recente.
    if (anterior && Number(anterior.turno) >= Number(v[c.turno])) continue;
    candidatos.set(v[c.sq], {
      sq: v[c.sq],
      nome: v[c.nome],
      nomeUrna: v[c.urna],
      cargo: v[c.cargo],
      uf: v[c.uf],
      ue: v[c.ue],
      numero: v[c.numero],
      partido: v[c.partido],
      coligacao: v[c.coligacao],
      composicaoColigacao: v[c.composicao],
      resultado: v[c.resultado],
      turno: v[c.turno],
    });
  }

  // Layout posicional do TSE: tipo de registro na posição 1, CNPJ em 4–17, razão social em 18–167.
  const cnpjPorRazao = new Map<string, string[]>();
  for (const linha of txt.split(/\r?\n/)) {
    if (linha[0] !== "2") continue;
    const cnpj = linha.slice(3, 17);
    const razao = norm(linha.slice(17, 167));
    const lista = cnpjPorRazao.get(razao) ?? [];
    lista.push(cnpj);
    cnpjPorRazao.set(razao, lista);
  }

  const cargos = new Set([...candidatos.values()].map((x) => norm(x.cargo)));
  const porCargo = new Map<string, { tokens: string[]; cnpj: string; razao: string }[]>();
  for (const [razao, cnpjs] of cnpjPorRazao) {
    const semPrefixo = razao.replace(/^ELEICAO \d{4} /, "");
    for (const cargo of cargos) {
      if (!semPrefixo.endsWith(` ${cargo}`)) continue;
      const tokens = semPrefixo.slice(0, -cargo.length - 1).split(" ");
      // "VICE GOVERNADOR" e "1 SUPLENTE SENADOR" também terminam com o cargo do titular.
      if (/^(VICE|SUPLENTE|\d+O?)$/.test(tokens[tokens.length - 1])) continue;
      const lista = porCargo.get(cargo) ?? [];
      for (const cnpj of cnpjs) lista.push({ tokens, cnpj, razao });
      porCargo.set(cargo, lista);
    }
  }

  return { candidatos, cnpjPorRazao, porCargo, geradoEm, carregadoEm: Date.now() };
}

async function obterBase(): Promise<BaseTSE> {
  if (cache && Date.now() - cache.carregadoEm < TTL_MS) return cache;
  emAndamento ??= carregar()
    .then((b) => (cache = b))
    .finally(() => (emAndamento = null));
  try {
    return await emAndamento;
  } catch (erro) {
    if (cache) return cache;
    throw erro;
  }
}

// ---------- casamento aproximado ----------

function distancia(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = tmp;
    }
  }
  return dp[b.length];
}

/** Coeficiente de Dice sobre as palavras, aceitando 1 letra de diferença em palavras com 4+ letras. */
function similaridade(a: string[], b: string[]): number {
  const restantes = [...b];
  let iguais = 0;
  for (const t of a) {
    const i = restantes.findIndex((u) => u === t || (t.length >= 4 && u.length >= 4 && distancia(t, u) <= 1));
    if (i >= 0) {
      iguais++;
      restantes.splice(i, 1);
    }
  }
  return (2 * iguais) / (a.length + b.length);
}

// ---------- OpenCNPJ ----------

export interface OpenCnpj {
  cnpj: string;
  razao_social: string;
  situacao_cadastral: string;
  data_inicio_atividade: string;
  natureza_juridica: string;
  email: string;
  telefones: { ddd: string; numero: string; is_fax: boolean }[];
  tipo_logradouro: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cep: string;
  municipio: string;
  uf: string;
  updated_at: string;
}

async function consultarCnpj(cnpj: string): Promise<OpenCnpj | null> {
  const guardado = cacheCnpj.get(cnpj);
  if (guardado && Date.now() - guardado.em < TTL_MS) return guardado.dados;
  let resp;
  try {
    resp = await baixar(`${OPENCNPJ}/${cnpj}`);
  } catch (e) {
    if (e instanceof Error && /HTTP 404/.test(e.message)) return null;
    throw e;
  }
  const dados = (await resp.json()) as OpenCnpj;
  cacheCnpj.set(cnpj, { dados, em: Date.now() });
  return dados;
}

// ---------- API do módulo ----------

const formatarCnpj = (c: string) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");

export function linkDivulgaCand(c: CandidatoTSE): string | null {
  const regiao = REGIAO[c.uf];
  if (!regiao) return null;
  return `https://divulgacandcontas.tse.jus.br/divulga/#/candidato/${regiao}/${c.uf}/${ELEICAO_DIVULGA}/${c.sq}/2026/${c.uf}`;
}

export interface ResultadoCampanha {
  candidato: CandidatoTSE;
  cnpj: string | null;
  confianca: "exata" | "aproximada (nome parecido, mesma UF)" | null;
  razaoNoTse?: string;
  receita: OpenCnpj | null;
  observacoes: string[];
  baseTseGeradaEm: string;
}

export async function candidatoTse(sq: string): Promise<CandidatoTSE | null> {
  return (await obterBase()).candidatos.get(sq) ?? null;
}

export async function dadosCampanha(sq: string): Promise<ResultadoCampanha | null> {
  const base = await obterBase();
  const candidato = base.candidatos.get(sq);
  if (!candidato) return null;
  const observacoes: string[] = [];
  const cargo = norm(candidato.cargo);

  // 1) Nome completo + cargo exatamente como na razão social.
  const exatos = base.cnpjPorRazao.get(norm(`ELEICAO 2026 ${candidato.nome} ${candidato.cargo}`)) ?? [];
  for (const cnpj of exatos) {
    const receita = await consultarCnpj(cnpj);
    // Homônimos no mesmo cargo existem; a UF do CNPJ desempata.
    if (exatos.length === 1 || receita?.uf === candidato.uf) {
      if (!receita) observacoes.push("CNPJ não encontrado no OpenCNPJ (a base da Receita pode ainda não ter sido atualizada).");
      return { candidato, cnpj, confianca: "exata", receita, observacoes, baseTseGeradaEm: base.geradoEm };
    }
  }

  // 2) Nome parecido no mesmo cargo, confirmado pela UF do cadastro na Receita.
  const alvo = norm(candidato.nome).split(" ");
  const parecidos = (base.porCargo.get(cargo) ?? [])
    .map((x) => ({ ...x, nota: similaridade(alvo, x.tokens) }))
    .filter((x) => x.nota >= 0.75)
    .sort((a, b) => b.nota - a.nota)
    .slice(0, 5);
  for (const p of parecidos) {
    const receita = await consultarCnpj(p.cnpj);
    if (receita?.uf === candidato.uf) {
      observacoes.push(
        `O nome no arquivo de CNPJs do TSE difere do cadastro de candidatos: "${p.razao}". ` +
          "O vínculo foi feito por semelhança de nome e confirmado pela UF; confira antes de usar.",
      );
      return {
        candidato,
        cnpj: p.cnpj,
        confianca: "aproximada (nome parecido, mesma UF)",
        razaoNoTse: p.razao,
        receita,
        observacoes,
        baseTseGeradaEm: base.geradoEm,
      };
    }
  }

  observacoes.push("Não encontrei o CNPJ de campanha deste candidato no arquivo do TSE.");
  return { candidato, cnpj: null, confianca: null, receita: null, observacoes, baseTseGeradaEm: base.geradoEm };
}

export function formatarCampanha(r: ResultadoCampanha) {
  const c = r.candidato;
  const rf = r.receita;
  const telefones = (rf?.telefones ?? [])
    .filter((t) => Number(t.ddd) > 0 && Number(t.numero) > 0)
    .map((t) => `(${t.ddd}) ${t.numero}${t.is_fax ? " (fax)" : ""}`);
  return {
    candidato: {
      sq: c.sq,
      nome_completo: c.nome,
      nome_de_urna: c.nomeUrna,
      cargo: c.cargo,
      uf: c.uf,
      numero: c.numero,
      partido: c.partido,
      coligacao: c.coligacao,
      composicao_coligacao: c.composicaoColigacao,
      resultado: c.resultado,
      link_divulgacandcontas: linkDivulgaCand(c),
    },
    campanha: r.cnpj
      ? {
          cnpj: formatarCnpj(r.cnpj),
          vinculo: r.confianca,
          ...(rf
            ? {
                razao_social: rf.razao_social,
                situacao_cadastral: rf.situacao_cadastral,
                aberto_em: rf.data_inicio_atividade,
                email: rf.email ? rf.email.toLowerCase() : null,
                telefones,
                endereco: [
                  [rf.tipo_logradouro && !rf.logradouro.startsWith(rf.tipo_logradouro) ? rf.tipo_logradouro : "", rf.logradouro]
                    .filter(Boolean)
                    .join(" "),
                  rf.numero,
                  rf.complemento,
                  rf.bairro,
                  `${rf.municipio}/${rf.uf}`,
                  rf.cep && `CEP ${rf.cep.padStart(8, "0").replace(/^(\d{5})(\d{3})$/, "$1-$2")}`,
                ]
                  .filter(Boolean)
                  .join(", "),
                receita_atualizada_em: rf.updated_at?.slice(0, 10),
              }
            : {}),
          consulta_opencnpj: `${OPENCNPJ}/${r.cnpj}`,
        }
      : null,
    observacoes: [
      ...r.observacoes,
      "O e-mail e o telefone são os informados à Receita Federal no registro do CNPJ de campanha. " +
        "Muitas vezes pertencem ao contador ou à equipe, não ao candidato.",
    ],
    fontes: {
      tse: `Portal de Dados Abertos do TSE (base gerada em ${r.baseTseGeradaEm})`,
      receita: "OpenCNPJ (base pública de CNPJs da Receita Federal)",
    },
  };
}

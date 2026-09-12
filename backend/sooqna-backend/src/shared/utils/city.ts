import { CITY_IDS } from "../constants/domain";

const CITY_ALIASES: Record<string, string> = {
  aleppo: "aleppo", "حلب": "aleppo",
  damascus: "damascus", "دمشق": "damascus",
  rifdimashq: "rifdimashq", "rif dimashq": "rifdimashq", "rif-dimashq": "rifdimashq", "ريف دمشق": "rifdimashq",
  homs: "homs", "حمص": "homs",
  hama: "hama", "حماة": "hama", "حمأة": "hama",
  latakia: "latakia", "اللاذقية": "latakia", "لاذقية": "latakia",
  tartus: "tartus", "طرطوس": "tartus",
  idlib: "idlib", "إدلب": "idlib", "ادلب": "idlib",
  daraa: "daraa", "درعا": "daraa",
  sweida: "sweida", "السويداء": "sweida", "السويدا": "sweida",
  quneitra: "quneitra", "القنيطرة": "quneitra",
  deirezzor: "deirezzor", "دير الزور": "deirezzor", "ديرالزور": "deirezzor",
  raqqa: "raqqa", "الرقة": "raqqa",
  alhasakah: "alhasakah", "الحسكة": "alhasakah", "الحسكه": "alhasakah",
};

/** Resolves Arabic, English, and slug spellings to the canonical stored city id. */
export function resolveCityId(input?: string | null): string | undefined {
  const alias = CITY_ALIASES[input?.trim().toLowerCase() ?? ""];
  return alias && CITY_IDS.includes(alias as (typeof CITY_IDS)[number]) ? alias : undefined;
}

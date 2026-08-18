# Amalgamarea teritorială APL I — PROPUNEREA FINALĂ (august 2026)

Varianta finală pentru faza normativă, rezultată din **patru iterații succesive de modelare**,
dezvoltate interactiv și comparate sistematic. Analiza acoperă numai teritoriul aflat sub autoritatea
autorităților constituționale; regiunea transnistreană și mun. Bender sunt excluse.

**Instrumente:** propunerile au fost determinate interactiv și iterativ cu sprijinul modelelor de
inteligență artificială **Claude Fable 5** și **OpenAI Sol 5.6 Extra High**, sub coordonarea și
validarea autorului.

## Iterațiile

| Iterația | Variante | Contribuția principală |
|---|---|---|
| 1 | V1 (strict legal, 222 UAT) și V2 (harta completă, 197 UAT) | ancorarea în designul teritorial al studiului 2018; registrul normativ complet (347 APL) |
| 2 | A și B (222 UAT) | timpi de parcurs măsurați pe rețeaua rutieră OSM; testul fiscal al Anexei 9 |
| 3 | V3 — hibrid (222 UAT, 13,7 min) | consens + arbitraj pe criterii explicite între Iterațiile 1 și 2 |
| 4 | propunerea revizuită (225 UAT, 12,9 min) | geometria corectată: 891 UAT, reintegrarea nucleelor Chișinău și Bălți, potriviri OSM refăcute |
| **Finală** | **225 UAT, 12,7 min** | sinteza Iterațiilor 3 și 4 |

## Rezultatul principal

- registru curent: **891 UAT** (inclusiv nucleele municipale Chișinău și Bălți), populație totală cu reședință obișnuită 2.409.207;
- propunerea finală: **225 UAT**, inclusiv Chișinău și Bălți ca ancore municipale autonome;
- **271 alocări normative** (APL <3.000 loc.) + **1 excepție** de statut special: Giurgiulești (1.936 loc., punct de frontieră/port, colț izolat);
- timp rutier mediu modelat: **12,7 minute**; o singură alocare peste 30 de minute;
- **71** clustere sub 5.000 locuitori (majoritatea: clustere voluntare intangibile);
- **51** clustere inter-raionale — raionul este atribut descriptiv, nu criteriu, bonus sau barieră;
- test fiscal (Anexa 9, 2018): **206/225** unități; neconformitățile sunt centre voluntare deja decise, semnalate pentru politici, nu înlocuite.

## Cum s-a construit varianta finală

1. **Consens deplin (189 alocări)** — Iterațiile 3 și 4 indică aceeași țintă; promovate ca atare.
2. **Iterația 4 (66 alocări)** — preluată unde timpul rutier măsurat este net superior sau unde geometria corectată a schimbat concluzia.
3. **Ajustări conform Iterației 3 (16 alocări)** — păstrate țintele care conțin partenerii de grup din scenariul moderat 2018,
   exclusiv acolo unde timpul de acces este egal sau mai bun decât alternativa (lista completă, cu justificări, în registru).
4. **Excepția Giurgiulești** — preluată din Iterația 4, cu statut special documentat.

Reguli invariante, verificate pe rezultatul final: cele 162 de clustere voluntare (inclusiv Leova și Călinești)
sunt tratate ca **nuclee intangibile** — componența inițială rezultată din amalgamarea voluntară și centrul
administrativ decis se păstrează integral (0 clustere divizate, 0 centre decise înlocuite) — dar nucleele **pot primi
noi UAT** prin alocările normative: 218 din cele 271 de alocări merg către clustere voluntare existente, iar 100 de
clustere au fost astfel extinse. Hotarele UTA Găgăuzia sunt păstrate; fiecare UAT apare exact o dată.

## Fișiere

- `Propunerea_FINALA_amalgamare.xlsx` — rezumat, comparația celor 7 variante, alocările UAT-cu-UAT cu proveniența deciziei, componența celor 225 unități, cele 16 ajustări justificate;
- `propunere_FINALA.geojson` — varianta finală pe geometria corectată (proprietăți complete per UAT);
- `harta_8_FINAL.png` — harta variantei finale;
- `Harta_interactiva_amalgamare.html` — hartă interactivă cu 8 straturi (voluntar, scenariile 2018, iterațiile, FINALĂ);
- `date-gis-apl1.zip` (~21 MB) — GeoPackage-ul cu cele 10 straturi GIS + proiectul QGIS + README (arhivat pentru limita Cloudflare Pages de 25 MiB);
- notele de fundamentare ale iterațiilor anterioare rămân valabile ca documentație a etapelor.

## Surse

Panoul Power BI al monitorizării amalgamării (extras 17.08.2026) · Studiul scenariilor de reformă
administrativ-teritorială (dec. 2018), Anexele 9–12 · Recensământul 2024 — populația cu reședința obișnuită ·
IVPF per capita (execuție 2024, modelul LPF) · OpenStreetMap/Geofabrik Moldova (04.08.2026).
Model tehnic auditabil pentru consultare și validare; nu reprezintă politică guvernamentală adoptată.

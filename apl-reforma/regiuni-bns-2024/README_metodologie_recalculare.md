# Geografia funcțională a Republicii Moldova — recalculare cu navetismul BNS 2024

## 1. Scop și statut

Acest pachet este o primă delimitare analitică reproductibilă a geografiei funcționale pe teritoriul administrat de autoritățile constituționale ale Republicii Moldova. El nu propune limite administrativ-teritoriale și nu utilizează apartenența la raion drept criteriu sau barieră.

Rezultatul distinge trei niveluri:

1. **arii urbane funcționale (FUA) candidate** pentru Chișinău și Bălți, delimitate strict prin navetism observat;
2. **32 de microregiuni**, construite din fluxuri observate, accesibilitate rutieră și contiguitate;
3. **7 regiuni funcționale provizorii**, construite din matricea completă origine–destinație agregată la microregiuni.

Toate delimitările sunt rezultate analitice și trebuie validate instituțional și local înainte de a fi folosite normativ.

## 2. Universul teritorial

- 897 UAT APL I din baza recensământului 2024;
- populație cu reședință obișnuită: **2.409.207 persoane**;
- 892 UAT au un poligon OSM reconciliat;
- 5 UAT fără limită OSM sigură sunt păstrate ca puncte: Chetriș, Hîncești (Fălești), Sărata-Răzeși, Sîrma și Tochile-Răducani;
- localitățile din regiunea transnistreană și municipiul Bender nu sunt incluse în delimitări;
- fluxurile raportate către stânga Nistrului/Bender sunt păstrate separat, fără a extinde automat regiunile peste Nistru.

## 3. Date utilizate

| Set de date | Utilizare | Statut în model |
|---|---|---|
| BNS, RPL 2024, tabelul 8.3 | populația cu reședință obișnuită la nivel de comună/oraș | observat/oficial |
| BNS, matricea localitate de reședință × localitate a locului de muncă | navetism, dependență de centru, autocontenție | observat/oficial |
| GHSL Urban Centre Database 2025, R2024A | geometria nucleelor urbane Chișinău și Bălți | observat/model global |
| OpenStreetMap | limite UAT, drumuri, puncte de servicii și localități | date colaborative; proxy |
| Administrația Națională a Drumurilor, harta ASD | control al clasificării și traseelor drumurilor | sursă oficială de validare; nu este redistribuită |

Surse online:

- BNS, distribuția populației pe localități: <https://statistica.gov.md/ro/rezultatele-finale-ale-recensamantului-populatiei-si-locuintelor-2024-distributi-10121_62380.html>
- BNS, caracteristici economice și navetism: <https://statistica.gov.md/ro/rezultatele-finale-ale-recensamantului-populatiei-si-locuintelor-2024-caracteris-10121_62102.html>
- GHSL Urban Centre Database 2025: <https://data.jrc.ec.europa.eu/dataset/1a338be6-7eaf-480c-9664-3a8ade88cbcd>
- OpenStreetMap și licența ODbL: <https://www.openstreetmap.org/copyright>
- harta drumurilor ASD: <https://harta.asd.md/>

Important: produsul global GHS-FUA publicat de JRC este încă aferent epocii 2015. În acest pachet, GHSL 2025 furnizează numai nucleele urbane; zonele de navetism sunt recalculate din datele BNS 2024.

## 4. Reconcilierea geografică

Cheia principală este codul CUATM din recensământ. Denumirile BNS au fost normalizate numai pentru legare. Au fost corectate explicit două variante istorice/ortografice: „Hligeni” → Glinjeni și „Carabetovka” → Carabetovca.

Pentru perechile urban/rural cu aceeași denumire — Dondușeni, Drochia, Ghindești, Mărculești, Ocnița și Cornești — poligonul urban a fost ales prin densitate plauzibilă și concordanță CUATM, iar poligonul rural prin geometria rămasă. Astfel au fost eliminate contururile albe/anormale din versiunea anterioară.

## 5. FUA candidate

Pentru fiecare UAT de origine `i` și nucleu urban `c`:

`P(i,c) = navetiști(i → c) / total rezidenți ocupați(i)`

Sunt publicate trei praguri de sensibilitate: 10%, 15% și 20%. Pragul principal este 15%, conform logicii EU–OECD. Nucleul este inclus întotdeauna. Dintre unitățile care trec pragul se păstrează numai componenta teritorială conectată la nucleu. Nu se aplică umplere recursivă a enclavelor.

La pragul de 15%:

- FUA Chișinău: 147 UAT, 1.004.193 locuitori;
- FUA Bălți: 39 UAT, 160.882 locuitori.

Aceste valori descriu o relație de navetism directă cu nucleul, nu întreaga arie de influență economică indirectă.

## 6. Microregiuni

Centrele candidate sunt selectate din localitățile urbane printr-un scor de centralitate care combină:

- populația 2024;
- locurile de muncă ocupate de rezidenți ai teritoriului analizat;
- navetismul intercomunal primit;
- servicii OSM de educație, sănătate, comerț/finanțe și administrație.

Chișinău, Bălți, Ungheni, Soroca, Orhei, Cahul și Comrat sunt ancore regionale obligatorii. Centrele foarte slabe sunt eliminate dacă atribuirea lor nu formează o zonă coerentă.

Alocarea UAT urmează două trepte:

1. **observată**: minimum 15% dintre rezidenții ocupați lucrează în centrul ales;
2. **modelată**: pentru unitățile rămase se combină fluxul observat către centru, timpul rutier, masa centrului și contiguitatea.

Rezultatul are 32 de microregiuni contigue. Din navetismul intercomunal de pe teritoriul analizat, **76,54%** rămâne în aceeași microregiune. 468 UAT sunt atribuite prin regula observată de 15%, 397 prin model și 32 sunt centre.

## 7. Timp și distanță

Drumurile OSM sunt transformate într-un graf rutabil. Timpul este suma lungimilor segmentelor împărțite la viteze orientative pe clase de drum; distanța este lungimea traseului cu cel mai mic timp.

- 889 UAT: traseu rutier OSM;
- 8 UAT: aproximare în linie dreaptă, marcată `straight_line_fallback`;
- mediană: 20,4 minute și 22,4 km;
- percentila 95: 54,6 minute și 64,8 km;
- maxim: 75,9 minute și 91,1 km.

Timpii sunt proxy-uri de accesibilitate cu automobilul, nu durate observate și nu includ congestia, orarele transportului public, starea sezonieră a drumului sau traversări cu regim special.

## 8. Regiuni funcționale mari

Fluxurile sunt agregate la cele 32 de microregiuni. Cele șapte regiuni sunt extinse contiguu de la ancorele Chișinău, Bălți, Ungheni, Soroca, Orhei, Cahul și Comrat, maximizând fluxurile bidirecționale interne și folosind accesibilitatea doar ca termen secundar.

Indicatorii principali sunt:

- autocontenția rezidenților: ponderea rezidenților regiunii care lucrează în regiune;
- autocontenția locurilor de muncă: ponderea locurilor de muncă din regiune ocupate de rezidenții regiunii;
- retenția navetismului intercomunal: ponderea navetismului dintre UAT care rămâne în regiune.

La nivel național, cele șapte regiuni rețin **90,05%** din navetismul intercomunal. Diferențele mari de populație și suprafață sunt un rezultat al centralizării fluxurilor, nu un obiectiv de echilibrare administrativă.

## 9. Limitări

- Navetismul este o măsură foarte importantă, dar nu acoperă fluxurile comerciale, de pacienți, elevi/studenți, marfă sau telefonie mobilă.
- Geometriile OSM nu sunt limite oficiale și cinci UAT nu au încă poligon sigur.
- Vitezele rutiere sunt valori modelate; harta ASD este folosită pentru control, dar datele sale vectoriale nu sunt redistribuite până la clarificarea licenței.
- Un prag FUA unic poate supraestima influența unui centru în UAT cu puțini rezidenți ocupați; de aceea sunt prezentate 10/15/20%.
- Atribuirile modelate trebuie afișate separat de cele observate.
- Rezultatul este sensibil la numărul și alegerea ancorelor regionale. O versiune viitoare trebuie să permită compararea automată a soluțiilor cu 5–9 regiuni.

## 10. Fișiere principale

- `moldova_functional_geography_bns_2024.gpkg` — GeoPackage cu toate straturile;
- `moldova_functional_geography_bns_2024.qgs` — proiect QGIS;
- `Harti_recalculate_navetism_BNS_2024.pdf` — trei pagini de hărți;
- `local_unit_assignments_bns_2024.csv` — atribuiri, timp, distanță și motiv;
- `micro_region_metrics.csv`, `functional_region_metrics.csv`, `fua_threshold_summary.csv` — indicatori;
- `commuting_od_matrix_cuatm.csv.gz` — matricea OD pe coduri CUATM;
- `validation_metrics.json` — sumar de control;
- `aplicatie/` — aplicația web Leaflet/Canvas, cu GeoJSON încorporat pentru deschidere locală sigură; MapLibre/PMTiles rămâne opțiunea recomandată pentru o versiune găzduită la scară mai mare.
- `harta_interactiva_geografie_functionala_BNS_2024.html` — aceeași aplicație într-un singur fișier HTML, cu datele încorporate.

## 11. Reproducere

Scriptul sursă este `work/functional_recalculation/recalculate_functional_geography.py`. El reconstruiește baza, matricele de rutare, atribuirile, indicatorii, GeoPackage-ul și hărțile. Orice versiune publicată trebuie să păstreze versiunea metodei, data surselor și un jurnal al parametrilor.

# Btechnics Energie

Home Assistant integratie en dashboardkaart voor het elektriciteitsverbruik van een aansluiting met een of meer driefasige meters (bijvoorbeeld Shelly Pro 3EM).

## Wat het doet

- Verbruik en kost per uur, kwartier, dag, week, maand en jaar, per meter en samen.
- Een dag in detail: per uur of per kwartier, per fase (vermogen, stroom, spanning), met de kost van die dag.
- Periodes naar keuze, gegroepeerd per dag, week of maand, met export naar CSV (Excel).
- Kwartierpiek per maand en de facturatiepiek (gemiddelde van de laatste 12 maandpieken, minimum 2,5 kW), als indicatie voor het capaciteitstarief van Fluvius.
- Tarief per kWh met historiek: elke dag wordt gerekend tegen het tarief dat toen gold.

## Installatie

1. HACS, Aangepaste repositories, `https://github.com/bogaertm/Btechnics_Energie`, type Integratie.
2. Installeren en Home Assistant herstarten.
3. Instellingen, Apparaten en diensten, Integratie toevoegen, Btechnics Energie. Kies de meters die samen de aansluiting vormen.
4. Dashboardkaart:

```yaml
type: custom:btechnics-energie
```

De kaart wordt door de integratie zelf geladen, er is geen manuele resource nodig.

## Werking

- Uur-, dag- en maandverbruik komen uit de langetermijnstatistieken van Home Assistant (die worden nooit gewist), als som van de energiesensoren per fase.
- Kwartieren: Home Assistant bewaart 5-minuutstatistieken maar 10 dagen. De integratie neemt ze elke 5 minuten over in `btechnics_energie.db` in de configmap, zodat kwartieren en maandpieken bewaard blijven.
- De piek is een benadering op basis van de meterstanden in Home Assistant. De officiele kwartierwaarden staan in Mijn Fluvius.
- Tarieven staan in `.storage/btechnics_energie_tarieven`. Bij de eerste start wordt de waarde van `input_number.energietarief_per_kwh` overgenomen als het eerste tarief, als die helper bestaat.

## Bronnen

- Fluvius, Hoe wordt het capaciteitstarief aangerekend: maandpiek is het hoogste kwartiervermogen van de maand, minimum 2,5 kW.
- Vlaamse Nutsregulator, Capaciteitstarief: facturatiepiek is het gemiddelde van de maandpieken van de afgelopen 12 maanden.

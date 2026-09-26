"""Btechnics Energie: verbruik, kost en kwartierpieken per meter."""
DOMAIN = "btechnics_energie"
CONF_METERS = "meters"          # lijst van {"id", "name", "device_id"}
QUARTER_DB = "btechnics_energie.db"
STORE_KEY = "btechnics_energie_tarieven"
STORE_VERSION = 1

# Capaciteitstarief (Fluvius, Vlaamse Nutsregulator): de maandpiek is het hoogste kwartiervermogen van
# de maand, minimum 2,5 kW; op de jaarafrekening telt het gemiddelde van de maandpieken van de
# afgelopen 12 maanden.
MIN_MONTH_PEAK_KW = 2.5
BILLING_MONTHS = 12

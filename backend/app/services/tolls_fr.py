"""
France: ESTIMATED motorway tolls - km on the tolled network (OpenStreetMap) x a per-km rate for class 1 (car up to
2 m, VAT included). The real price is per entry/exit pair and differs between operators and sections; official grids
are PDFs per operator (APRR/AREA, Vinci: ASF/Cofiroute/Escota, Sanef/SAPN...). Until those are imported, every
operator starts with the national average and the admin can set its rate. Open-system barriers are priced by km too.
"""
from typing import List, Tuple

from app.services.tolls_km import KmTolls

RATES: List[Tuple[str, str, float, str, bool]] = []   # filled when operator rates are checked (admin "Our €")

FR = KmTolls(
    cc="FR", name="French", bbox=(41.3, -5.2, 51.1, 9.6), rates=RATES, default_rate=0.10,
    source_page="https://www.autoroutes.fr/fr/les-tarifs-de-peage.htm",
    note="Estimate: km on tolled motorways (OpenStreetMap) x average class 1 rate (about 0.09-0.12 EUR/km depending "
         "on the operator); the price at the booth depends on the exact entry and exit.",
    min_km_total=6000, must_have=r"aprr|vinci|asf|sanef", round_step=0.1)

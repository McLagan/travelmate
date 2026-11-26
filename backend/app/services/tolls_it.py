"""
Italy: ESTIMATED motorway tolls (no official free price matrix exists) - km x rate of the concessionaire, class A,
VAT and ANAS share included, rounded to 0.10 EUR per ticket; a few roads charge a flat fee. Engine: tolls_km.
Known simplifications: plain rate for operators that also have mountain sections (ASPI mountain is ~18% dearer),
link roads and free stretches around toll plazas are not counted, open-system barriers are priced by km.
"""
from typing import List, Tuple

from app.services.tolls_km import KmTolls

# (operator regex, kind, class A EUR/km incl. VAT - or flat EUR, source, verified)
RATES: List[Tuple[str, str, float, str, bool]] = [
    (r"autostrade per l.? ?italia", "km", 0.07869, "autostrade.it 2026, plain (mountain 0.09315)", True),
    (r"satap", "km", 0.1400, "satapweb.it 2026: Torino-Novara Est 0.13794, Novara Est-Milano 0.14155", True),
    (r"brennero", "km", 0.0700, "autobrennero.it 2026: plain 0.06412, mountain 0.07592 (average)", True),
    (r"brebemi", "km", 0.23169, "brebemi.it (A35)", True),
    (r"raccordo autostradale valle|\brav\b", "km", 0.29354, "ravspa.it (mountain)", True),
    (r"ivrea torino piacenza|\bitp\b", "km", 0.083753, "itpspa.it A5/A55 plain 2026", True),
    (r"\bcav\b|concessioni autostradali venete", "km", 0.06577, "cavspa.it via calcolo.tools (A4 Padova-Mestre)", False),
    (r"salerno pompei napoli", "flat", 2.30, "salernopompeinapolispa.it flat class A", True),
    (r"tangenziale di napoli", "flat", 1.00, "default, not verified", False),
]

IT = KmTolls(
    cc="IT", name="Italian", bbox=(35.4, 6.5, 47.2, 18.6), rates=RATES, default_rate=0.085,
    source_page="https://www.autostrade.it/en/servizi-al-cliente/pedaggio/come-si-calcola-il-pedaggio",
    note="Estimate: km on tolled motorways (OpenStreetMap) x 2026 class A rate of each operator; "
         "mountain sections and open-system barriers can differ.",
    min_km_total=4000, must_have="autostrade per", round_step=0.1, rate_source="it_rate")

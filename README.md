# Saunaan

A phone web app that finds public saunas near you, wherever you travel.

**Open it:** https://kimmsavo73.github.io/sauna-finder/

- **Near me** uses your phone's location; or type any city or address.
- Results come live from [OpenStreetMap](https://www.openstreetmap.org/) via the Overpass API: saunas, public baths, hammams, onsen and swimming halls tagged with a sauna.
- Each result shows distance, whether it's open now (from mapped opening hours), price, mixed or separate sections, and one-tap directions in Google Maps or Apple Maps.
- Saunas mapped as private (`access=private`) are left out. Saunas with no name or details are hidden by default, because most of those are private saunas in apartment buildings; tick **Include unverified** to see them.
- Add it to your home screen (Share → Add to Home Screen on iPhone, menu → Install app on Android). The last search is kept so it opens offline.

No accounts, no tracking, no paid APIs. Your location is only sent to the Overpass server as the centre of the search.

Missing or wrong sauna? Fix it on OpenStreetMap and it shows up here within minutes.

Map library: [Leaflet](https://leafletjs.com/) 1.9.4 (BSD-2-Clause), bundled in `vendor/`.

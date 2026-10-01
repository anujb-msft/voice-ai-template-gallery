import { readJson, norm } from "./fixtures.mjs";

export class FixtureGeocoder {
  name = "fixture";
  constructor(addresses, streets) {
    this.addresses = addresses;
    this.streets = streets;
  }
  static load(addressesPath, streetsPath) { return new FixtureGeocoder(readJson(addressesPath), readJson(streetsPath)); }

  resolve(utterance) {
    const text = norm(utterance);
    const exactAddress = this.addresses.find((a) => text.includes(norm(a.address)) || (text.includes(norm(a.street)) && /\b\d+\b/.test(text) && text.includes(String(a.address.match(/\d+/)?.[0]))));
    if (exactAddress) return verified("address", exactAddress.address, exactAddress);

    const streetHits = this.streets.filter((s) => [s.name, ...(s.aliases ?? [])].some((x) => text.includes(norm(x))));
    if (streetHits.length >= 2) {
      const [a, b] = streetHits;
      const intersection = a.intersections.find((i) => norm(i.with) === norm(b.name));
      if (intersection) return verified("intersection", `${a.name} at ${b.name}`, intersection);
    }
    if (streetHits.length === 1 && /library/.test(text)) {
      const lib = this.addresses.find((a) => /library/i.test(a.address));
      return { ...verified("landmark", "in front of the library", lib), landmark: "in front of the library" };
    }
    if (streetHits.length === 1) {
      const candidates = streetHits[0].intersections.map((i) => ({ label: `${streetHits[0].name} at ${i.with}`, lat: i.lat, lon: i.lon, zone: i.zone }));
      return { ok: false, ambiguous: true, candidates, confirmation: `I found more than one location on ${streetHits[0].name}. Which cross street?` };
    }
    return { ok: false, unverified: true, landmark: utterance, confirmation: "I could not verify that location. I can save it as a landmark note." };
  }
}

function verified(kind, label, point) {
  return { ok: true, kind, normalized: label, lat: point.lat, lon: point.lon, zone: point.zone, confirmation: `${label} — is that right?`, ambiguous: false };
}

export function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

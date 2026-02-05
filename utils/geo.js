/**
 * Geographic utilities
 * Shared Haversine distance calculations and geofence logic
 */

/**
 * Calculate distance between two GPS coordinates using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lon1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lon2 - Longitude of second point
 * @param {string} unit - 'km' for kilometers, 'm' for meters (default: 'm')
 * @returns {number} - Distance in specified unit
 */
export const haversineDistance = (lat1, lon1, lat2, lon2, unit = 'm') => {
  const R = unit === 'km' ? 6371 : 6371000; // Earth's radius in km or meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

/**
 * Check if a point is inside a geofence (circular boundary)
 * @param {number} lat - Latitude of point to check
 * @param {number} lng - Longitude of point to check
 * @param {number} centerLat - Latitude of geofence center
 * @param {number} centerLng - Longitude of geofence center
 * @param {number} radiusMeters - Radius of geofence in meters
 * @returns {boolean} - True if point is inside geofence
 */
export const pointInsideGeofence = (lat, lng, centerLat, centerLng, radiusMeters) => {
  if (Number.isNaN(lat) || Number.isNaN(lng)) return false;
  const dist = haversineDistance(lat, lng, centerLat, centerLng, 'm');
  return dist <= radiusMeters;
};

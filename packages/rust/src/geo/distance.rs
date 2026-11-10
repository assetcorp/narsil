use super::constants::{
    EARTH_RADIUS_METRES, VINCENTY_CONVERGENCE_THRESHOLD, VINCENTY_MAX_ITERATIONS,
};
use super::math::{atan, atan2, cos, sin, tan};

pub(crate) const DEGREES_TO_RADIANS: f64 = std::f64::consts::PI / 180.0;

const WGS84_A: f64 = 6_378_137.0;
const WGS84_F: f64 = 1.0 / 298.257_223_563;
const WGS84_B: f64 = WGS84_A * (1.0 - WGS84_F);

#[derive(Debug, Clone, Copy)]
pub(crate) struct HaversineOrigin {
    lat: f64,
    lon: f64,
    latitude_cosine: f64,
}

impl HaversineOrigin {
    pub(crate) fn new(lat: f64, lon: f64) -> HaversineOrigin {
        HaversineOrigin {
            lat,
            lon,
            latitude_cosine: cos(lat * DEGREES_TO_RADIANS),
        }
    }

    pub(crate) fn half_chord(&self, lat: f64, lon: f64) -> f64 {
        let phi = lat * DEGREES_TO_RADIANS;
        let delta_phi = (lat - self.lat) * DEGREES_TO_RADIANS;
        let delta_lambda = (lon - self.lon) * DEGREES_TO_RADIANS;
        let half_delta_phi = sin(delta_phi / 2.0);
        let half_delta_lambda = sin(delta_lambda / 2.0);
        half_delta_phi * half_delta_phi
            + self.latitude_cosine * cos(phi) * half_delta_lambda * half_delta_lambda
    }
}

pub(crate) fn half_chord_of_angle(angle: f64) -> f64 {
    let half_chord_sine = sin(angle / 2.0);
    half_chord_sine * half_chord_sine
}

pub(crate) fn distance_of_chord(half_chord: f64) -> f64 {
    let central = 2.0 * atan2(half_chord.sqrt(), (1.0 - half_chord).sqrt());
    EARTH_RADIUS_METRES * central
}

pub(crate) fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    distance_of_chord(HaversineOrigin::new(lat1, lon1).half_chord(lat2, lon2))
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct VincentyOrigin {
    lat: f64,
    lon: f64,
    sin_u1: f64,
    cos_u1: f64,
}

impl VincentyOrigin {
    pub(crate) fn new(lat: f64, lon: f64) -> VincentyOrigin {
        let u1 = atan((1.0 - WGS84_F) * tan(lat * DEGREES_TO_RADIANS));
        VincentyOrigin {
            lat,
            lon,
            sin_u1: sin(u1),
            cos_u1: cos(u1),
        }
    }

    pub(crate) fn distance(&self, lat2: f64, lon2: f64) -> f64 {
        let (sin_u1, cos_u1) = (self.sin_u1, self.cos_u1);
        let phi2 = lat2 * DEGREES_TO_RADIANS;
        let longitude_step = (lon2 - self.lon) * DEGREES_TO_RADIANS;
        let u2 = atan((1.0 - WGS84_F) * tan(phi2));
        let sin_u2 = sin(u2);
        let cos_u2 = cos(u2);
        let mut lambda = longitude_step;
        let mut sin_sigma;
        let mut cos_sigma;
        let mut sigma;
        let mut cos2_alpha;
        let mut cos2_sigma_m;
        let mut iterations = VINCENTY_MAX_ITERATIONS;
        loop {
            let sin_lambda = sin(lambda);
            let cos_lambda = cos(lambda);
            let term1 = cos_u2 * sin_lambda;
            let term2 = cos_u1 * sin_u2 - sin_u1 * cos_u2 * cos_lambda;
            sin_sigma = (term1 * term1 + term2 * term2).sqrt();
            if sin_sigma == 0.0 {
                return 0.0;
            }
            cos_sigma = sin_u1 * sin_u2 + cos_u1 * cos_u2 * cos_lambda;
            sigma = atan2(sin_sigma, cos_sigma);
            let sin_alpha = (cos_u1 * cos_u2 * sin_lambda) / sin_sigma;
            cos2_alpha = 1.0 - sin_alpha * sin_alpha;
            cos2_sigma_m = if cos2_alpha == 0.0 {
                0.0
            } else {
                cos_sigma - (2.0 * sin_u1 * sin_u2) / cos2_alpha
            };
            let c = (WGS84_F / 16.0) * cos2_alpha * (4.0 + WGS84_F * (4.0 - 3.0 * cos2_alpha));
            let previous_lambda = lambda;
            lambda = longitude_step
                + (1.0 - c)
                    * WGS84_F
                    * sin_alpha
                    * (sigma
                        + c * sin_sigma
                            * (cos2_sigma_m
                                + c * cos_sigma * (-1.0 + 2.0 * cos2_sigma_m * cos2_sigma_m)));
            let moving = (lambda - previous_lambda).abs() > VINCENTY_CONVERGENCE_THRESHOLD;
            if !moving {
                break;
            }
            iterations -= 1;
            if iterations == 0 {
                return haversine_distance(self.lat, self.lon, lat2, lon2);
            }
        }
        let u_square = (cos2_alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
        let a = 1.0
            + (u_square / 16384.0)
                * (4096.0 + u_square * (-768.0 + u_square * (320.0 - 175.0 * u_square)));
        let b = (u_square / 1024.0)
            * (256.0 + u_square * (-128.0 + u_square * (74.0 - 47.0 * u_square)));
        let delta_sigma = b
            * sin_sigma
            * (cos2_sigma_m
                + (b / 4.0)
                    * (cos_sigma * (-1.0 + 2.0 * cos2_sigma_m * cos2_sigma_m)
                        - (b / 6.0)
                            * cos2_sigma_m
                            * (-3.0 + 4.0 * sin_sigma * sin_sigma)
                            * (-3.0 + 4.0 * cos2_sigma_m * cos2_sigma_m)));
        WGS84_B * a * (sigma - delta_sigma)
    }
}

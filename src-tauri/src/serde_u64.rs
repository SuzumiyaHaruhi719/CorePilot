//! Serde helpers for `u64` fields that must cross the IPC / JSON boundary as
//! decimal *strings*.
//!
//! JavaScript `number` is an IEEE-754 f64 and can only represent integers
//! exactly up to 2^53. CPU-affinity masks set one bit per logical processor, so
//! on machines with > 53 logical CPUs (HEDT: Threadripper / EPYC, up to 64 in a
//! single Windows processor group) the high bits would lose precision if sent as
//! JSON numbers. Serializing the `u64` as a decimal string keeps every bit
//! intact; the frontend parses it into a `bigint`.

/// Serialize a `u64` as a decimal string, and deserialize from *either* a JSON
/// string (the new wire format) or a JSON number (back-compat with any value
/// produced before this change).
pub mod str {
    use serde::de::{self, Visitor};
    use serde::{Deserializer, Serializer};
    use std::fmt;

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(U64Visitor)
    }

    /// Accepts a decimal string, or any JSON integer, and yields a `u64`.
    struct U64Visitor;

    impl<'de> Visitor<'de> for U64Visitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a u64 as a decimal string or a number")
        }

        fn visit_str<E>(self, value: &str) -> Result<u64, E>
        where
            E: de::Error,
        {
            value.parse::<u64>().map_err(de::Error::custom)
        }

        fn visit_u64<E>(self, value: u64) -> Result<u64, E>
        where
            E: de::Error,
        {
            Ok(value)
        }

        fn visit_i64<E>(self, value: i64) -> Result<u64, E>
        where
            E: de::Error,
        {
            u64::try_from(value).map_err(de::Error::custom)
        }

        fn visit_f64<E>(self, value: f64) -> Result<u64, E>
        where
            E: de::Error,
        {
            // serde_json hands integral JSON numbers to visit_u64/visit_i64, but
            // a value parsed as f64 (e.g. arbitrary deserializers) is accepted
            // when it is a non-negative integer within u64 range.
            if value.is_finite() && value >= 0.0 && value <= u64::MAX as f64 && value.fract() == 0.0
            {
                Ok(value as u64)
            } else {
                Err(de::Error::custom("expected a non-negative integer"))
            }
        }
    }
}

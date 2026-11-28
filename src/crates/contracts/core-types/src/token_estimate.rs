//! Shared request token estimates and output reserves.

use crate::{Message, ToolDefinition};

pub const INPUT_SAFETY_RESERVE: usize = 10_000;
const INPUT_SAFETY_RESERVE_RATIO_PERCENT: usize = 5;
/// Size reserved for path-only history, opaque URLs or unreadable headers.
pub const UNKNOWN_IMAGE_DIMENSIONS: (u32, u32) = (2048, 2048);
const AUTOMATIC_MAX_OUTPUT_TOKEN_TIERS: [u32; 5] = [8_000, 16_000, 24_000, 32_000, 64_000];
const AUTOMATIC_MAX_OUTPUT_RATIO_PERCENT: u32 = 16;

/// Estimation and framing margin reserved before hitting the hard context
/// window. Scales at 5% for smaller windows and caps at [`INPUT_SAFETY_RESERVE`].
pub fn input_safety_reserve(context_window: usize) -> usize {
    let scaled =
        ((context_window as u128) * (INPUT_SAFETY_RESERVE_RATIO_PERCENT as u128) / 100) as usize;
    INPUT_SAFETY_RESERVE.min(scaled)
}

/// Model-neutral estimate used before the runtime selects a provider.
pub fn estimate_image_tokens(width: u32, height: u32) -> usize {
    let grid = u64::from(width.div_ceil(512)) * u64::from(height.div_ceil(512));
    usize::try_from(50 + 200 * grid).unwrap_or(usize::MAX)
}

/// Read inline image dimensions from base64-encoded headers without decoding a pixel buffer.
pub fn inline_image_dimensions(mime_type: &str, data_base64: &str) -> Option<(u32, u32)> {
    let kind = ImageHeaderKind::from_mime_type(mime_type)?;
    let encoded = data_base64.as_bytes();
    const PREFIX: usize = 4096; // Complete base64 quartets.
    if encoded.len() > PREFIX {
        let prefix = decode_base64(&encoded[..PREFIX])?;
        if let Some(size) = parse_image_dimensions(kind, &prefix) {
            return Some(size);
        }
    }
    let decoded = decode_base64(encoded)?;
    parse_image_dimensions(kind, &decoded)
}

#[derive(Clone, Copy)]
enum ImageHeaderKind {
    Png,
    Jpeg,
    Gif,
    WebP,
    Bmp,
}

impl ImageHeaderKind {
    fn from_mime_type(mime_type: &str) -> Option<Self> {
        let base = mime_type
            .split(';')
            .next()
            .unwrap_or(mime_type)
            .trim()
            .to_ascii_lowercase();
        match base.as_str() {
            "image/png" => Some(Self::Png),
            "image/jpeg" | "image/jpg" => Some(Self::Jpeg),
            "image/gif" => Some(Self::Gif),
            "image/webp" => Some(Self::WebP),
            "image/bmp" | "image/x-ms-bmp" => Some(Self::Bmp),
            _ => None,
        }
    }
}

fn decode_base64(input: &[u8]) -> Option<Vec<u8>> {
    if input.is_empty() || !input.len().is_multiple_of(4) {
        return None;
    }
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity((input.len() / 4) * 3);
    let last_chunk_index = input.len() / 4 - 1;
    for (idx, chunk) in input.chunks_exact(4).enumerate() {
        let a = sextet(chunk[0])?;
        let b = sextet(chunk[1])?;
        match (chunk[2], chunk[3]) {
            (b'=', b'=') if idx == last_chunk_index => {
                out.push((a << 2) | (b >> 4));
            }
            (c, b'=') if idx == last_chunk_index => {
                let c = sextet(c)?;
                out.push((a << 2) | (b >> 4));
                out.push((b << 4) | (c >> 2));
            }
            (c, d) => {
                let c = sextet(c)?;
                let d = sextet(d)?;
                out.push((a << 2) | (b >> 4));
                out.push((b << 4) | (c >> 2));
                out.push((c << 6) | d);
            }
        }
    }
    Some(out)
}

fn parse_image_dimensions(kind: ImageHeaderKind, bytes: &[u8]) -> Option<(u32, u32)> {
    let size = match kind {
        ImageHeaderKind::Png => {
            if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR"
            {
                return None;
            }
            let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
            let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
            (width, height)
        }
        ImageHeaderKind::Gif => {
            if bytes.len() < 10 || (&bytes[..6] != b"GIF87a" && &bytes[..6] != b"GIF89a") {
                return None;
            }
            let width = u32::from(u16::from_le_bytes([bytes[6], bytes[7]]));
            let height = u32::from(u16::from_le_bytes([bytes[8], bytes[9]]));
            (width, height)
        }
        ImageHeaderKind::Bmp => {
            if bytes.len() < 26 || &bytes[..2] != b"BM" {
                return None;
            }
            let dib_size = u32::from_le_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
            if dib_size == 12 {
                let width = u32::from(u16::from_le_bytes([bytes[18], bytes[19]]));
                let height = u32::from(u16::from_le_bytes([bytes[20], bytes[21]]));
                (width, height)
            } else if dib_size >= 40 {
                let width =
                    i32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]).unsigned_abs();
                let height =
                    i32::from_le_bytes([bytes[22], bytes[23], bytes[24], bytes[25]]).unsigned_abs();
                (width, height)
            } else {
                return None;
            }
        }
        ImageHeaderKind::WebP => {
            if bytes.len() < 25 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
                return None;
            }
            match &bytes[12..16] {
                b"VP8 " => {
                    if bytes.len() < 30 || bytes[23..26] != [0x9d, 0x01, 0x2a] {
                        return None;
                    }
                    let width = u32::from(u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3FFF);
                    let height = u32::from(u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3FFF);
                    (width, height)
                }
                b"VP8L" => {
                    if bytes.len() < 25 || bytes[20] != 0x2f {
                        return None;
                    }
                    let bits = u32::from_le_bytes([bytes[21], bytes[22], bytes[23], bytes[24]]);
                    let width = (bits & 0x3FFF) + 1;
                    let height = ((bits >> 14) & 0x3FFF) + 1;
                    (width, height)
                }
                b"VP8X" => {
                    if bytes.len() < 30 {
                        return None;
                    }
                    let width = u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]) + 1;
                    let height = u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]) + 1;
                    (width, height)
                }
                _ => return None,
            }
        }
        ImageHeaderKind::Jpeg => {
            if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
                return None;
            }
            let mut i = 2;
            loop {
                while i < bytes.len() && bytes[i] != 0xFF {
                    i += 1;
                }
                while i < bytes.len() && bytes[i] == 0xFF {
                    i += 1;
                }
                if i >= bytes.len() {
                    return None;
                }
                let marker = bytes[i];
                i += 1;
                if marker == 0xD9 || marker == 0xDA {
                    return None;
                }
                if marker == 0x00 || marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
                    continue;
                }
                if i + 2 > bytes.len() {
                    return None;
                }
                let length = usize::from(u16::from_be_bytes([bytes[i], bytes[i + 1]]));
                if length < 2 {
                    return None;
                }
                if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
                    if i + 7 > bytes.len() {
                        return None;
                    }
                    let height = u32::from(u16::from_be_bytes([bytes[i + 3], bytes[i + 4]]));
                    let width = u32::from(u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]));
                    break (width, height);
                }
                i = i.checked_add(length)?;
            }
        }
    };
    (size.0 > 0 && size.1 > 0).then_some(size)
}

/// Chooses the largest supported output tier that does not exceed 16% of the
/// model context window (e.g. 16k at 128k, 32k at 200k-399k, 64k at 400k+).
pub fn automatic_max_output_tokens(context_window: u32) -> u32 {
    let max_output =
        (u64::from(context_window) * u64::from(AUTOMATIC_MAX_OUTPUT_RATIO_PERCENT) / 100) as u32;
    AUTOMATIC_MAX_OUTPUT_TOKEN_TIERS
        .iter()
        .rev()
        .copied()
        .find(|tier| *tier <= max_output)
        .unwrap_or(max_output)
}

/// Heuristic: ASCII chars 0.3 token, non-ASCII chars 0.6 token
pub struct TokenCounter;

impl TokenCounter {
    pub fn estimate_tokens(text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }

        let mut token_count: f32 = 0.;

        for c in text.chars() {
            if c.is_ascii() {
                token_count += 0.3;
            } else {
                token_count += 0.6;
            }
        }

        token_count as usize
    }

    pub fn estimate_message_tokens(message: &Message) -> usize {
        Self::estimate_message_overhead(message)
            + message.content.as_deref().map_or(0, Self::estimate_tokens)
    }

    /// Message envelope, reasoning, tool calls and name, excluding content.
    pub fn estimate_message_overhead(message: &Message) -> usize {
        let mut total = 4;

        if let Some(reasoning_content) = &message.reasoning_content {
            total += Self::estimate_tokens(reasoning_content);
        }

        if let Some(tool_calls) = &message.tool_calls {
            for tool_call in tool_calls {
                total += Self::estimate_tokens(&tool_call.name);
                total += Self::estimate_tokens(&tool_call.serialized_arguments());
                total += 10;
            }
        }

        if let Some(name) = &message.name {
            total += Self::estimate_tokens(name);
        }

        total
    }

    pub fn estimate_messages_tokens(messages: &[Message]) -> usize {
        let mut total: usize = messages.iter().map(Self::estimate_message_tokens).sum();

        total += 3;

        total
    }

    pub fn estimate_tool_definitions_tokens(tools: &[ToolDefinition]) -> usize {
        let mut total = 0;

        for tool in tools {
            total += Self::estimate_tokens(&tool.name);
            total += Self::estimate_tokens(&tool.description);

            if let Ok(json_str) = serde_json::to_string(&tool.parameters) {
                total += Self::estimate_tokens(&json_str);
            }

            total += 15;
        }

        if !tools.is_empty() {
            total += 10;
        }

        total
    }

    pub fn estimate_request_tokens(
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
    ) -> usize {
        let mut total = Self::estimate_messages_tokens(messages);

        if let Some(tool_defs) = tools {
            total += Self::estimate_tool_definitions_tokens(tool_defs);
        }

        total
    }
}

#[cfg(test)]
mod tests {
    use super::{
        automatic_max_output_tokens, estimate_image_tokens, inline_image_dimensions,
        input_safety_reserve, INPUT_SAFETY_RESERVE,
    };

    #[test]
    fn scales_input_safety_reserve_and_caps_at_default_constant() {
        assert_eq!(input_safety_reserve(0), 0);
        assert_eq!(input_safety_reserve(32_000), 1_600);
        assert_eq!(input_safety_reserve(64_000), 3_200);
        assert_eq!(input_safety_reserve(128_000), 6_400);
        assert_eq!(input_safety_reserve(200_000), INPUT_SAFETY_RESERVE);
        assert_eq!(input_safety_reserve(1_000_000), INPUT_SAFETY_RESERVE);
    }

    #[test]
    fn automatic_output_tiers_stay_within_sixteen_percent_of_context() {
        assert_eq!(automatic_max_output_tokens(32_000), 5_120);
        assert_eq!(automatic_max_output_tokens(64_000), 8_000);
        assert_eq!(automatic_max_output_tokens(128_000), 16_000);
        assert_eq!(automatic_max_output_tokens(150_000), 24_000);
        assert_eq!(automatic_max_output_tokens(200_000), 32_000);
        assert_eq!(automatic_max_output_tokens(399_999), 32_000);
        assert_eq!(automatic_max_output_tokens(400_000), 64_000);
        assert_eq!(automatic_max_output_tokens(1_000_000), 64_000);
    }

    fn encode_base64(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0];
            let b1 = chunk.get(1).copied().unwrap_or(0);
            let b2 = chunk.get(2).copied().unwrap_or(0);
            out.push(TABLE[(b0 >> 2) as usize] as char);
            out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
            out.push(if chunk.len() > 1 {
                TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                TABLE[(b2 & 0x3f) as usize] as char
            } else {
                '='
            });
        }
        out
    }

    #[test]
    fn parses_png_jpeg_gif_webp_and_bmp_inline_dimensions() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&1920u32.to_be_bytes());
        png.extend_from_slice(&1080u32.to_be_bytes());
        assert_eq!(
            inline_image_dimensions("image/png", &encode_base64(&png)),
            Some((1920, 1080))
        );

        let jpeg = vec![
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x02,
            0x80, 0x03, 0x20, 0x01, 0x00, 0x00, 0x00, 0xFF, 0xD9,
        ];
        assert_eq!(
            inline_image_dimensions("image/jpeg", &encode_base64(&jpeg)),
            Some((800, 640))
        );

        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&320u16.to_le_bytes());
        gif.extend_from_slice(&240u16.to_le_bytes());
        assert_eq!(
            inline_image_dimensions("image/gif", &encode_base64(&gif)),
            Some((320, 240))
        );

        let mut webp_vp8x = b"RIFF".to_vec();
        webp_vp8x.extend_from_slice(&30u32.to_le_bytes());
        webp_vp8x.extend_from_slice(b"WEBPVP8X");
        webp_vp8x.extend_from_slice(&10u32.to_le_bytes());
        webp_vp8x.extend_from_slice(&[0; 4]);
        let w = 1024u32 - 1;
        let h = 768u32 - 1;
        webp_vp8x.extend_from_slice(&w.to_le_bytes()[..3]);
        webp_vp8x.extend_from_slice(&h.to_le_bytes()[..3]);
        assert_eq!(
            inline_image_dimensions("image/webp", &encode_base64(&webp_vp8x)),
            Some((1024, 768))
        );

        let mut bmp = vec![0u8; 26];
        bmp[0..2].copy_from_slice(b"BM");
        bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
        bmp[18..22].copy_from_slice(&640i32.to_le_bytes());
        bmp[22..26].copy_from_slice(&(-480i32).to_le_bytes());
        assert_eq!(
            inline_image_dimensions("image/bmp", &encode_base64(&bmp)),
            Some((640, 480))
        );

        assert_eq!(inline_image_dimensions("image/png", "not-valid!!!"), None);
        assert_eq!(estimate_image_tokens(512, 512), 250);
        assert_eq!(estimate_image_tokens(2048, 2048), 3250);
    }
}

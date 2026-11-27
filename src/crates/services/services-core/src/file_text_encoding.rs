//! Strict decoding of workspace text with an identity for the original bytes.

use encoding_rs::{GBK, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextFileEncoding {
    Utf8,
    Utf8Bom,
    Gbk,
    Gb2312,
    Utf16le,
    Utf16be,
    Iso88591,
}

/// `sha256` identifies the original bytes for a checked save, including any BOM.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedTextFile {
    pub content: String,
    pub encoding: TextFileEncoding,
    pub has_bom: bool,
    pub sha256: String,
}

impl TextFileEncoding {
    pub fn decode(self, bytes: &[u8]) -> Result<DecodedTextFile, String> {
        let (decoder, bom): (_, &[u8]) = match self {
            Self::Utf8 | Self::Utf8Bom => (UTF_8, b"\xef\xbb\xbf"),
            Self::Utf16le => (UTF_16LE, b"\xff\xfe"),
            Self::Utf16be => (UTF_16BE, b"\xfe\xff"),
            // GB2312 is the legacy label for the GBK decoder.
            Self::Gbk | Self::Gb2312 => (GBK, b""),
            Self::Iso88591 => {
                return Ok(self.snapshot(
                    bytes,
                    bytes.iter().copied().map(char::from).collect(),
                    false,
                ));
            }
        };
        let has_bom = !bom.is_empty() && bytes.starts_with(bom);
        let payload = if has_bom { &bytes[bom.len()..] } else { bytes };
        let content = decoder
            .decode_without_bom_handling_and_without_replacement(payload)
            .ok_or("FILE_ENCODING_INVALID")?;
        Ok(self.snapshot(bytes, content.into_owned(), has_bom))
    }

    fn snapshot(self, bytes: &[u8], content: String, has_bom: bool) -> DecodedTextFile {
        DecodedTextFile {
            content,
            encoding: self,
            has_bom,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_editor_catalog_without_hiding_loss() {
        for (encoding, bytes, text, has_bom) in [
            (TextFileEncoding::Utf8, &b"text"[..], "text", false),
            (
                TextFileEncoding::Utf8Bom,
                &b"\xef\xbb\xbftext"[..],
                "text",
                true,
            ),
            (
                TextFileEncoding::Gbk,
                &b"\xd6\xd0\xce\xc4"[..],
                "中文",
                false,
            ),
            (
                TextFileEncoding::Gb2312,
                &b"\xd6\xd0\xce\xc4"[..],
                "中文",
                false,
            ),
            (
                TextFileEncoding::Utf16le,
                &b"\xff\xfe\x2d\x4e"[..],
                "中",
                true,
            ),
            (
                TextFileEncoding::Utf16be,
                &b"\xfe\xff\x4e\x2d"[..],
                "中",
                true,
            ),
            (
                TextFileEncoding::Iso88591,
                &b"\xe9\x80"[..],
                "é\u{80}",
                false,
            ),
        ] {
            let snapshot = encoding.decode(bytes).unwrap();
            assert_eq!(snapshot.content, text);
            assert_eq!(snapshot.encoding, encoding);
            assert_eq!(snapshot.has_bom, has_bom);
            assert_eq!(snapshot.sha256, format!("{:x}", Sha256::digest(bytes)));
        }
        assert!(TextFileEncoding::Utf8.decode(b"\xff").is_err());
        assert!(TextFileEncoding::Utf16be.decode(b"\x4e").is_err());
        assert!(TextFileEncoding::Gbk.decode(b"\xd6").is_err());
    }
}

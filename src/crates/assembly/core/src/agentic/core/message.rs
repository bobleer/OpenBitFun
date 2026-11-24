//! Compatibility exports for production context and model history.
pub use openbitfun_agent_runtime::message::*;

#[cfg(test)]
mod tests {
    use super::{ImageContextData, Message, ToolResult};
    use crate::util::types::ToolImageAttachment;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn restored_tool_results_and_inline_uploads_use_the_encoded_image_dimensions() {
        for (size, expected_tokens) in [(512, 250), (2048, 3250)] {
            let mut png = Cursor::new(Vec::new());
            image::DynamicImage::new_luma8(size, size)
                .write_to(&mut png, image::ImageFormat::Png)
                .unwrap();
            let data = STANDARD.encode(png.into_inner());
            let user = Message::user_multimodal(
                "Screenshot".into(),
                vec![ImageContextData {
                    id: "screenshot".into(),
                    image_path: None,
                    data_url: Some(format!("data:image/png;base64,{data}")),
                    mime_type: "image/png".into(),
                    metadata: None,
                }],
            );
            let mut result = ToolResult {
                tool_id: "call".into(),
                tool_name: "view_image".into(),
                effective_tool_name: None,
                result: json!({}),
                result_for_assistant: Some("Screenshot".into()),
                is_error: false,
                duration_ms: None,
                image_attachments: None,
            };
            let text_tokens =
                Message::tool_result(result.clone()).estimate_tokens_with_reasoning(false);
            result.image_attachments = Some(vec![ToolImageAttachment {
                mime_type: "image/png".into(),
                data_base64: data,
            }]);

            let stored = serde_json::to_value(Message::tool_result(result)).unwrap();
            let restored: Message = serde_json::from_value(stored).unwrap();
            for message in [user, restored] {
                assert_eq!(
                    message.estimate_non_image_tokens_with_reasoning(false),
                    text_tokens
                );
                assert_eq!(
                    message.estimate_tokens_with_reasoning(false) - text_tokens,
                    expected_tokens
                );
            }
        }
    }
}

import { mount, Scroll, Text, View } from "nsh";
import { Scrollbar, TextView } from "nsh/base";
import { palette, selectAppearancePreset, syncGlobalNativeTheme, textStyle } from "../../src/theme";
import { createMarkdownStyles } from "../../src/ui/markdown";

// Label the real app theme's tracks so tests can measure and drag them.
const setTheme = Scrollbar.setTheme;
Scrollbar.setTheme = theme => setTheme(theme ? {
  ...theme,
  horizontal: { ...theme.horizontal, accessibilityLabel: "horizontal-track" },
} : theme);
syncGlobalNativeTheme();

function Gallery() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 16, backgroundColor: palette().canvas }}>
      <Text style={textStyle("body")} onPress={() => selectAppearancePreset("openbitfun-light")}>Light appearance</Text>
      <View testID="code" style={{ width: "100%" }}>
        <TextView
          markdown={`\`\`\`ts\nconst message = "${"wide code ".repeat(30)}";\nconsole.log(message);\n\`\`\``}
          styles={createMarkdownStyles()}
        />
      </View>
      <View testID="table" style={{ width: "100%" }}>
        <TextView
          markdown={`| ${Array.from({ length: 8 }, (_, i) => `Column ${i}`).join(" | ")} |\n| ${Array(8).fill("---").join(" | ")} |\n| ${Array(8).fill("Wide table cell").join(" | ")} |\n| ${Array(8).fill("Another row").join(" | ")} |`}
          styles={createMarkdownStyles()}
        />
      </View>
      <Scroll testID="row" horizontal style={{ width: "100%", height: 80 }}>
        <View testID="row-content" style={{ width: 1800, height: 80, backgroundColor: palette().surfaceTertiary }}>
          <Text style={textStyle("body")}>Wide horizontal content</Text>
        </View>
      </Scroll>
    </View>
  );
}

mount(Gallery);

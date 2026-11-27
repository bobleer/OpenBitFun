import { mount, signal, View } from "nsh";
import { palette, space } from "../../src/theme";
import { CardView } from "../../src/ui/cardView";
import { Button } from "../../src/ui/primitives";

const styles = ["line", "donut", "stacked", "column", "bar"];
const chart = signal(styles[0]);
const samples = signal([-10, 25, -2]);
const data = () => ({ labels: ["Monday", "Tuesday", "Wednesday"], total: chart() === "bar" ? 10 : 50, samples: samples() });

function ChartsApp() {
  return <View style={{ flex: 1, backgroundColor: palette().canvas, padding: space.sm, gap: space.sm }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
      <Each of={styles} key={style => style}>
        {style => <Button label={style()} onPress={() => chart.set(style())} />}
      </Each>
      <Button label="Update samples" onPress={() => samples.set([-10, 25, 7])} />
    </View>
    <CardView deviceId="" placement="inline" card={{ id: "chart-sample", title: "Weekly activity", accent: "accent",
      template: { kind: "chart", chart: chart(), itemsPath: "/samples", labelsPath: "/labels", totalPath: "/total",
        caption: "Last three days", remainderLabel: "Unused" }, data: data() }} />
  </View>;
}

mount(ChartsApp);

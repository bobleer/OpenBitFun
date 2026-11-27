import { mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SelectDropdown } from "../../src/ui/overlays";

const options = [
  { value: "alpha", label: "Alpha" },
  { value: "bravo", label: "Bravo", disabled: true },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma" },
  { value: "delta", label: "Delta", disabled: true },
];

function App() {
  const choice = signal("alpha");
  return (
    <View style={{ flex: 1, maxWidth: 360, padding: 24, gap: 20 }}>
      <Input autoFocus testID="before-select" style={{ height: 32 }} />
      <SelectDropdown
        testID="plain-select"
        accessibilityLabel="Plain choice"
        options={options}
        value={choice()}
        onChange={value => choice.set(value)}
      />
      <SelectDropdown
        testID="filtered-select"
        accessibilityLabel="Filtered choice"
        searchable
        searchPlaceholder="Filter choices"
        options={options}
        value={choice()}
        onChange={value => choice.set(value)}
      />
      <Input testID="after-select" style={{ height: 32 }} />
      <Text>{`Saved: ${choice()}`}</Text>
    </View>
  );
}

mount(App);

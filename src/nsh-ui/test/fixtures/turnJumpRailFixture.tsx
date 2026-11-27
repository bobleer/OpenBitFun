// Interactive harness for `TurnJumpRail` covering 20, 25, 100, and 1,000 turns
// plus short-viewport responsive capping, for `test/turn-jump-rail.test.tsx`.
import "../../src/agentEvents";
import { Text, View, computed, mount, signal } from "nsh";
import { palette, space, textStyle } from "../../src/theme";
import { Button } from "../../src/ui/primitives";
import { TurnJumpRail, type TurnJumpPreviewData } from "../../src/ui/TurnJumpRail";

interface FixtureTurn {
  key: string;
  index: number;
  prompt: string;
  reply: string;
  timestamp: number;
}

const BASE_TS = 1763100000000;

function makeTurns(count: number): FixtureTurn[] {
  return Array.from({ length: count }, (_, idx) => {
    const n = idx + 1;
    const topic = n === 357 ? "Quantum cache invalidation strategy" : `Topic ${n} architecture note`;
    return {
      key: `turn-${n}`,
      index: idx,
      prompt: `Prompt #${n}: ${topic}`,
      reply: `Reply for turn ${n} with concise summary.`,
      timestamp: BASE_TS + idx * 60_000,
    };
  });
}

const turnCount = signal(20);
const activeKey = signal("turn-20");
const lastJumped = signal("none");
const stageHeight = signal(640);

const turns = computed(() => makeTurns(turnCount()));
const turnsByKey = computed(() => {
  const map = new Map<string, FixtureTurn>();
  for (const item of turns()) map.set(item.key, item);
  return map;
});

function setCount(next: number): void {
  turnCount.set(next);
  activeKey.set(`turn-${next}`);
  lastJumped.set("none");
}

function previewOf(key: string): TurnJumpPreviewData | null {
  const item = turnsByKey().get(key);
  if (!item) return null;
  return {
    prompt: item.prompt,
    reply: item.reply,
    timestamp: item.timestamp,
  };
}

function Harness() {
  return (
    <View style={{ flex: 1, backgroundColor: palette().canvas, padding: space.lg, gap: space.md }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
        <Button label="Count 20" onPress={() => setCount(20)} />
        <Button label="Count 25" onPress={() => setCount(25)} />
        <Button label="Count 100" onPress={() => setCount(100)} />
        <Button label="Count 1000" onPress={() => setCount(1000)} />
        <Button label="Activate 42" onPress={() => activeKey.set("turn-42")} />
        <Button label="Height 640" onPress={() => stageHeight.set(640)} />
        <Button label="Height 300" onPress={() => stageHeight.set(300)} />
      </View>

      <Text accessibilityLabel="rail-status" style={textStyle("caption")}>
        {`jumped=${lastJumped()} active=${activeKey()} total=${turnCount()}`}
      </Text>

      <View
        style={{
          height: stageHeight(),
          width: "100%",
          position: "relative",
          borderWidth: 1,
          borderColor: palette().borderSubtle,
          backgroundColor: palette().canvas,
        }}
      >
        <TurnJumpRail
          rows={turns}
          previewOf={previewOf}
          activeKey={activeKey}
          onJump={key => {
            lastJumped.set(key);
            activeKey.set(key);
          }}
        />
      </View>
    </View>
  );
}

mount(() => <Harness />);

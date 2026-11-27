import { mount, View } from "nsh";
import { createMobileShell } from "../../../apps/mobile-nsh/src/mobileShell";
import { installWindowShell } from "../../src/bridge";
import { codeReviewReport } from "../../src/codeReviewReport";
import { CodeReviewReport } from "../../src/ui/CodeReviewReport";
import { ToastHost } from "../../src/ui/overlays";

installWindowShell(createMobileShell());

const report = codeReviewReport({ summary: { overall_assessment: "Saved review evidence" }, issues: [] })!;

mount(() => <View style={{ flex: 1 }}>
  <CodeReviewReport report={report} />
  <ToastHost />
</View>);

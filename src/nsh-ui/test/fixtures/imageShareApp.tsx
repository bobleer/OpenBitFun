import "./installObpSocket";
import { createMobileShell } from "../../../apps/mobile-nsh/src/mobileShell";
import { installWindowShell } from "../../src/bridge";
import "../../App";

installWindowShell(createMobileShell());

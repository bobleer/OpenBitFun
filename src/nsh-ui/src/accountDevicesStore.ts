// The account device actions the device page offers: rename (the account
// alias) and remove from the account. The device list the UI draws is the
// fleet navigator's; it is refreshed after an account change so the new name
// or the removal shows without waiting for the next index event.

import { signal } from "nsh";
import { fleetActive, invokeCommand, invokeRawCommand } from "./bridge";
import { localDeviceId } from "./devicePrefsStore";
import { refreshFleetNavigator } from "./fleetStore";
import { loadAccountState } from "./homeStore";
import { localizeHostError, tr } from "./i18n";
import { pushToast } from "./ui/overlays";

const removeDeviceBusy = signal(false);
const saveAliasBusy = signal(false);

async function afterAccountChange(): Promise<void> {
  if (fleetActive()) await refreshFleetNavigator({ full: true });
}

/**
 * Removes a device from the account (`account_delete_device`, positional
 * `targetDeviceId`). Removing this machine signs it out, as on the desktop.
 */
export async function removeAccountDevice(deviceId: string, label?: string): Promise<void> {
  if (removeDeviceBusy()) return;
  const name = label || deviceId;
  const isLocal = deviceId === localDeviceId();
  removeDeviceBusy.set(true);
  try {
    await invokeRawCommand<unknown>("account_delete_device", { targetDeviceId: deviceId });
    pushToast(isLocal ? tr("devices.currentDeviceRemoved") : tr("devices.deviceRemoved", { name }), "success");
    if (isLocal) await loadAccountState();
    await afterAccountChange();
  } catch (error) {
    pushToast(localizeHostError(error instanceof Error ? error.message : String(error)), "error");
  } finally {
    removeDeviceBusy.set(false);
  }
}

/** Persists a device alias; an empty alias clears it and the account falls back to the name. */
export async function saveDeviceAlias(deviceId: string, alias: string): Promise<boolean> {
  if (saveAliasBusy()) return false;
  const trimmed = alias.trim();
  saveAliasBusy.set(true);
  try {
    await invokeCommand<unknown>("account_update_device_alias", {
      device_id: deviceId,
      device_alias: trimmed || null,
    });
    await afterAccountChange();
    return true;
  } catch (error) {
    pushToast(localizeHostError(error instanceof Error ? error.message : String(error)), "error");
    return false;
  } finally {
    saveAliasBusy.set(false);
  }
}

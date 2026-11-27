import { fleetModelText, readChatModelsForDevice, readFleetModelsForDevice, type FleetModelsDevice, type ModelOption } from "../modelStore";

interface ModelPickerRow {
  ref: string;
  label: string;
  detail: string;
  providerLabel: string;
  exact: string[];
  searchable: string;
  selectable: boolean;
  primary?: boolean;
}

export interface ModelPickerGroup {
  device?: FleetModelsDevice;
  rows: ModelPickerRow[];
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function modelPickerCatalog(local: ModelOption[], fleet: FleetModelsDevice[] | null): ModelPickerGroup[] {
  if (!fleet) return [{ rows: local.map(model => ({
    ref: model.id, label: model.label, detail: model.detail, providerLabel: model.detail || model.provider,
    exact: [model.label, model.modelName, model.configId, model.id].map(normalize),
    searchable: normalize([model.label, model.detail, model.configName, model.modelName, model.provider, model.configId, model.id].join(" ")),
    selectable: model.chat,
  })) }];

  return fleet.map(device => ({ device, rows: device.models.map(model => {
    const { label, detail } = fleetModelText(model);
    return {
      ref: model.modelRef, label, detail, providerLabel: detail || model.provider,
      exact: [label, model.displayName, model.modelName ?? "", model.modelId, model.modelRef].map(normalize),
      searchable: normalize([label, detail, model.displayName, model.modelName, model.provider, model.modelId,
        model.modelRef, device.name, device.deviceId].join(" ")),
      selectable: model.selectable, primary: model.primary,
    };
  }) }));
}

export async function readModelPickerCatalog(deviceId: string): Promise<ModelPickerGroup[]> {
  const groups = await readFleetModelsForDevice(deviceId).catch(() => null);
  return modelPickerCatalog(groups ? [] : await readChatModelsForDevice(deviceId), groups);
}

export function findModelPickerMatches(groups: ModelPickerGroup[], query: string) {
  const exactQuery = normalize(query);
  const exact = groups.flatMap(group => group.rows.filter(row => row.selectable && row.exact.includes(exactQuery))
    .map(row => ({ row, device: group.device })));
  if (exact.length) return exact;
  return filterModelPickerCatalog(groups, query, null).flatMap(group => group.rows.filter(row => row.selectable)
    .map(row => ({ row, device: group.device })));
}

export function modelPickerProviders(groups: ModelPickerGroup[]): Array<{ id: string; label: string }> {
  const providers = new Map<string, string>();
  for (const { rows } of groups) {
    for (const row of rows) {
      const id = normalize(row.providerLabel);
      if (id && !providers.has(id)) providers.set(id, row.providerLabel);
    }
  }
  return Array.from(providers, ([id, label]) => ({ id, label }));
}

export function filterModelPickerCatalog(groups: ModelPickerGroup[], query: string, provider: string | null): ModelPickerGroup[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length && !provider) return groups;
  return groups.map(group => ({ ...group, rows: group.rows.filter(row =>
    (!provider || normalize(row.providerLabel) === provider) && terms.every(term => row.searchable.includes(term)),
  ) })).filter(group => group.rows.length);
}

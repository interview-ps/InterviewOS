import { useEffect, useState } from "react";
import {
  api,
  type PluginSettingField,
} from "@/lib/api";
import { Button, toast } from "@/components/ui";

/**
 * v1: auto-rendered form for a plugin's manifest `settings` declaration.
 * Used on /skills plugin cards and under /settings "Plugin settings".
 */
export function PluginSettingsForm({
  pluginId,
  pluginName,
}: {
  pluginId: string;
  pluginName?: string;
}) {
  const [fields, setFields] = useState<PluginSettingField[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .pluginSettings(pluginId)
      .then((r) => {
        if (!live) return;
        setFields(r.fields);
        setValues(r.values);
      })
      .catch(() => setFields([]));
    return () => {
      live = false;
    };
  }, [pluginId]);

  if (fields === null || fields.length === 0) return null;

  const update = (key: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setDirty(true);
  };

  const save = () => {
    setBusy(true);
    setError(null);
    api
      .setPluginSettings(pluginId, values)
      .then((r) => {
        setValues(r.values);
        setDirty(false);
        toast(`Settings saved for ${pluginName ?? pluginId}`);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid={`plugin-settings-${pluginId}`}>
      {fields.map((f) => (
        <label key={f.key} className="mb-2 block text-sm">
          <span className="font-medium text-navy">{f.label}</span>
          {f.description && (
            <span className="ml-2 text-xs text-muted">{f.description}</span>
          )}
          {f.type === "boolean" ? (
            <input
              type="checkbox"
              className="ml-2 align-middle"
              checked={values[f.key] === true}
              onChange={(e) => update(f.key, e.target.checked)}
            />
          ) : f.type === "enum" ? (
            <select
              className="mt-1 block rounded-[var(--radius-sm)] border border-line bg-page px-2 py-1 text-sm"
              value={String(values[f.key] ?? "")}
              onChange={(e) => update(f.key, e.target.value)}
            >
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.type === "number" ? "number" : "text"}
              className="mt-1 block w-64 rounded-[var(--radius-sm)] border border-line bg-page px-2 py-1 text-sm"
              value={String(values[f.key] ?? "")}
              onChange={(e) =>
                update(
                  f.key,
                  f.type === "number" ? Number(e.target.value) : e.target.value,
                )
              }
            />
          )}
        </label>
      ))}
      {error != null && (
        <p role="alert" className="text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <Button
        variant="secondary"
        disabled={busy || !dirty}
        onClick={save}
        data-testid={`save-plugin-settings-${pluginId}`}
      >
        {busy ? "Applying…" : "Apply settings"}
      </Button>
    </div>
  );
}

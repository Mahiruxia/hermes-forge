"""Launch the pinned official Gateway with Forge's per-process extension policy.

Hermes 0.21.3 has no CLI switch to suspend its built-in cron scheduler. This
adapter uses its scheduler provider interface without rewriting user jobs/config.
The regular official CLI still owns startup, shutdown, and platform behavior.
"""
import os
import inspect
import runpy
import sys


def validate_extension_contract(gateway_run, scheduler_provider):
    missing = []
    for owner, names in [
        (gateway_run, ["load_gateway_config_for_runner"]),
        (scheduler_provider, ["resolve_cron_scheduler", "scheduler_for_profile_mode"]),
        (getattr(scheduler_provider, "InProcessCronScheduler", None), ["start", "stop"]),
    ]:
        for name in names:
            if not callable(getattr(owner, name, None)):
                missing.append(name)
    if not missing:
        try:
            inspect.signature(scheduler_provider.InProcessCronScheduler.start).bind(None, None, adapters=None, loop=None)
        except TypeError:
            missing.append("InProcessCronScheduler.start(stop_event, adapters=..., loop=...)")
    if missing:
        raise RuntimeError("Hermes Gateway API is incompatible: " + ", ".join(missing))


def apply_extension_policy(gateway_run, scheduler_provider, connectors_enabled, cron_enabled):
    if not connectors_enabled:
        original_loader = gateway_run.load_gateway_config_for_runner

        def load_without_connectors():
            config = original_loader()
            config.platforms = {}
            config.multiplex_profiles = False
            return config

        gateway_run.load_gateway_config_for_runner = load_without_connectors

    if not cron_enabled:
        class PausedCronScheduler(scheduler_provider.InProcessCronScheduler):
            def start(self, stop_event, **kwargs):
                stop_event.wait()

        scheduler_provider.resolve_cron_scheduler = PausedCronScheduler


def main():
    from gateway import run as gateway_run
    from cron import scheduler_provider

    validate_extension_contract(gateway_run, scheduler_provider)
    apply_extension_policy(
        gateway_run, scheduler_provider,
        os.environ.get("HERMES_FORGE_CONNECTORS_ENABLED") == "1",
        os.environ.get("HERMES_FORGE_CRON_ENABLED") == "1",
    )
    sys.argv = ["hermes", "gateway", "run", *sys.argv[1:]]
    runpy.run_module("hermes_cli.main", run_name="__main__")


if __name__ == "__main__":
    main()

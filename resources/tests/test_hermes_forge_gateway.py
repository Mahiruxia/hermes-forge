import importlib.util
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("forge_gateway", Path(__file__).resolve().parents[1] / "hermes-forge-gateway.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class GatewayPolicyTests(unittest.TestCase):
    def fixture(self):
        configured = {"telegram": "saved-token", "api_server": "saved-key"}
        gateway = SimpleNamespace(load_gateway_config_for_runner=Mock(side_effect=lambda: SimpleNamespace(platforms=dict(configured), multiplex_profiles=True)))

        class Scheduler:
            def start(self, stop_event, *, adapters=None, loop=None, **kwargs):
                raise AssertionError("Disabled scheduler must never dispatch")

            def stop(self):
                pass

            def list_jobs(self):
                return ["existing-job"]

        scheduler = SimpleNamespace(InProcessCronScheduler=Scheduler, resolve_cron_scheduler=Scheduler,
                                    scheduler_for_profile_mode=lambda provider, **kwargs: provider)
        return gateway, scheduler, configured

    def test_disabled_extensions_leave_saved_config_and_jobs_untouched(self):
        gateway, scheduler, configured = self.fixture()
        bridge.validate_extension_contract(gateway, scheduler)
        bridge.apply_extension_policy(gateway, scheduler, False, False)
        config = gateway.load_gateway_config_for_runner()
        self.assertEqual(config.platforms, {})
        self.assertFalse(config.multiplex_profiles)
        self.assertEqual(configured, {"telegram": "saved-token", "api_server": "saved-key"})
        provider = scheduler.resolve_cron_scheduler()
        self.assertIsInstance(provider, scheduler.InProcessCronScheduler)
        self.assertEqual(provider.list_jobs(), ["existing-job"])
        stop = threading.Event()
        thread = threading.Thread(target=provider.start, args=(stop,), kwargs={"adapters": {}, "loop": None, "profile_homes": lambda: [], "can_dispatch": lambda: True})
        thread.start()
        self.assertTrue(thread.is_alive())
        stop.set()
        thread.join(1)
        self.assertFalse(thread.is_alive())

    def test_enabled_extensions_keep_the_official_loader_and_provider(self):
        gateway, scheduler, _configured = self.fixture()
        loader, resolver = gateway.load_gateway_config_for_runner, scheduler.resolve_cron_scheduler
        bridge.apply_extension_policy(gateway, scheduler, True, True)
        self.assertIs(gateway.load_gateway_config_for_runner, loader)
        self.assertIs(scheduler.resolve_cron_scheduler, resolver)
        self.assertEqual(set(loader().platforms), {"telegram", "api_server"})

    def test_each_flag_is_independent(self):
        for connectors, cron in [(True, False), (False, True)]:
            with self.subTest(connectors=connectors, cron=cron):
                gateway, scheduler, _configured = self.fixture()
                loader, resolver = gateway.load_gateway_config_for_runner, scheduler.resolve_cron_scheduler
                bridge.apply_extension_policy(gateway, scheduler, connectors, cron)
                self.assertEqual(gateway.load_gateway_config_for_runner is loader, connectors)
                self.assertEqual(scheduler.resolve_cron_scheduler is resolver, cron)

    def test_missing_pinned_gateway_api_fails_before_launch(self):
        gateway, scheduler, _configured = self.fixture()
        del gateway.load_gateway_config_for_runner
        with self.assertRaisesRegex(RuntimeError, "load_gateway_config_for_runner"):
            bridge.validate_extension_contract(gateway, scheduler)

    def test_main_uses_process_flags_and_preserves_official_gateway_arguments(self):
        gateway, scheduler, _configured = self.fixture()
        modules = {"gateway": SimpleNamespace(run=gateway), "cron": SimpleNamespace(scheduler_provider=scheduler)}
        with patch.dict(bridge.sys.modules, modules), patch.dict(bridge.os.environ, {"HERMES_FORGE_CONNECTORS_ENABLED": "1", "HERMES_FORGE_CRON_ENABLED": "1"}), patch.object(bridge.sys, "argv", ["wrapper", "--replace"]), patch.object(bridge.runpy, "run_module") as run:
            bridge.main()
            self.assertEqual(bridge.sys.argv, ["hermes", "gateway", "run", "--replace"])
            run.assert_called_once_with("hermes_cli.main", run_name="__main__")


if __name__ == "__main__":
    unittest.main()

"""E2E runner: one shared server for the main suites + dedicated auth server.

Usage: .venv/bin/python tests/run_e2e.py
"""

from __future__ import annotations

import sys

import harness
from harness import Server

# Importing registers the @test functions
import e2e_query  # noqa: F401
import e2e_control  # noqa: F401
import e2e_worker  # noqa: F401
import e2e_worker_ack_batch  # noqa: F401
import e2e_flow  # noqa: F401
import e2e_admin  # noqa: F401
import e2e_simple  # noqa: F401
import e2e_simple_extras  # noqa: F401
import e2e_audit_fixes  # noqa: F401
import e2e_spec_align  # noqa: F401
import e2e_realistic  # noqa: F401
import e2e_edge  # noqa: F401
import e2e_telemetry  # noqa: F401
import e2e_serialization  # noqa: F401
import e2e_hardening  # noqa: F401
import e2e_durations  # noqa: F401
import e2e_durations_simple  # noqa: F401
import e2e_sdk_clamps  # noqa: F401
import e2e_compat  # noqa: F401
import e2e_connection_close  # noqa: F401
import test_compat_options
import test_compat_simple
import test_worker_pull_errors
import test_worker_wire_errors
from e2e_auth import run_auth_tests
from e2e_worker_refusals import CHECKS as REFUSAL_CHECKS, run_refusal_tests
from worker_fakes import run_module


def main() -> int:
    print(
        f"collected {len(harness.TESTS)} shared-server tests + 3 auth tests"
        f" + {len(REFUSAL_CHECKS)} worker-refusal tests + broker-free worker/compat tests\n"
    )
    server = Server().start()
    try:
        failed = harness.run_registered(server)
    finally:
        server.stop()

    failed += run_auth_tests()
    failed += e2e_audit_fixes.run_standalone_audit_tests()
    failed += run_refusal_tests()
    total = len(harness.TESTS) + 3 + 3 + len(REFUSAL_CHECKS)  # +3 standalone audit checks
    # Broker-free Worker error-path and 0.2.0-compatibility tests (also
    # collected by pytest).
    for module in (
        test_worker_pull_errors,
        test_worker_wire_errors,
        test_compat_options,
        test_compat_simple,
    ):
        count, module_failed = run_module(module)
        total += count
        failed += module_failed
    print(f"\n{total - failed}/{total} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

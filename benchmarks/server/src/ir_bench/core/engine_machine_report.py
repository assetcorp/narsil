from __future__ import annotations


def engine_on_another_machine(env: dict) -> bool:
    return isinstance(env.get("engine_machine"), dict)


def harness_machine_heading(env: dict) -> str:
    return "Load machine" if engine_on_another_machine(env) else "Machine"


def memory_held_by_engine_machine(env: dict) -> object:
    machine = env.get("engine_machine")
    if isinstance(machine, dict):
        return machine.get("total_memory_bytes")
    return env.get("total_memory_bytes")


def engine_machine_lines(env: dict) -> list[str]:
    lines: list[str] = []
    if env.get("engine_machine_label"):
        lines.append(f"- Engine machine label: {env.get('engine_machine_label')}")
    machine = env.get("engine_machine")
    if isinstance(machine, dict):
        machine_memory = machine.get("total_memory_bytes")
        memory_text = "n/a" if not isinstance(machine_memory, int) else f"{machine_memory / 1e9:.1f} GB"
        lines.append(
            f"- Engine machine: {machine.get('cpu_model')} ({machine.get('cpus')} logical), {memory_text}"
        )
    network = env.get("network")
    if isinstance(network, dict):
        round_trip = network.get("round_trip_ms") or {}
        lines.append(
            f"- Network round trip to the engine machine: p50 {round_trip.get('p50', 0.0):.3f} ms, "
            f"p99 {round_trip.get('p99', 0.0):.3f} ms over {network.get('samples')} TCP connects"
        )
    return lines

# ComfyUI Fleet

Run workflows across multiple ComfyUI machines using the normal **Run** button.
Fleet sends each complete workflow job to an available worker and brings the
results back to your controller's ComfyUI history. Accepted jobs keep running
after you close the browser.

## Install

**Copy this repository's contents into `ComfyUI/custom_nodes/ComfyUI-Fleet` on
your controller, then restart ComfyUI and refresh your browser.**

Or, from your ComfyUI directory:

```sh
git clone https://github.com/Cinderella-Man/comfyui-fleet.git custom_nodes/ComfyUI-Fleet
```

The controller needs Linux, Python 3.12+, ComfyUI 0.37.0+ and frontend 1.52.7+.
Workers need ComfyUI 0.37.0+ and the models and custom nodes your workflows use.
**Install Fleet only on the controller.**

See [installation](docs/INSTALL.md) for folder layout and network requirements.

## Run your first jobs

1. Open **Fleet** in the sidebar. Enter a worker's private IP address and port,
   such as `192.168.1.20:8188`, and click **Add node**.
2. Add your other workers, then click **Done** to save them.
3. Load a workflow, choose a count and click **Run**. A count of eight submits
   eight complete workflow jobs, distributed across your available workers.

Use [the usage guide](docs/USAGE.md) for queue ordering, cancellation, results
and limitations. See [backups and troubleshooting](docs/RECOVERY.md) if work
needs attention.

## Videos

### Add nodes

https://github.com/user-attachments/assets/d5e7653f-d027-4b1f-9456-16389811f7f6

### Submit jobs

https://github.com/user-attachments/assets/2c0fcabc-8420-496e-b444-64cdea8f122f

### Reorder queued batches

https://github.com/user-attachments/assets/f009ed65-5e4f-4e0f-882a-8ea678afe505

### Set node priority

https://github.com/user-attachments/assets/350ed8f3-d247-43d2-a64b-0e50e62a41f4

## Development

[Run tests and build a release archive](docs/DEVELOPMENT.md).

## License

[GNU GPL version 3](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md)
for the frontend code attribution.

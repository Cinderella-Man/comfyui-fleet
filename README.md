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

https://github.com/user-attachments/assets/f23f42b0-9340-48a5-a32c-ce2d40709c58

### Submit jobs

https://github.com/user-attachments/assets/4dc647fe-fb62-4641-84c4-01fed5828784

### Reorder queued batches

https://github.com/user-attachments/assets/2496c077-d3da-4aaa-bdbb-e20df2b2b93e

### Set node priority

https://github.com/user-attachments/assets/9a9bee2a-06bf-4840-aac2-b8ff9ec85ccb

## Development

[Run tests and build a release archive](docs/DEVELOPMENT.md).

## License

[GNU GPL version 3](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md)
for the frontend code attribution.

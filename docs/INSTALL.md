# Install Fleet

**Copy this repository's contents into `ComfyUI/custom_nodes/ComfyUI-Fleet`
on the controller. Restart ComfyUI, refresh your browser and open the Fleet
sidebar. That's the installation.**

The controller is the ComfyUI instance you open in your browser. Workers are
the ComfyUI instances that execute jobs. Workers do not need Fleet installed.

## Check the folder

Your files should look like this, without an extra nested repository folder:

```text
ComfyUI/
└── custom_nodes/
    └── ComfyUI-Fleet/
        ├── __init__.py
        ├── fleet/
        └── web/
```

If you prefer Git, run this from the ComfyUI directory instead of copying files:

```sh
git clone https://github.com/Cinderella-Man/comfyui-fleet.git custom_nodes/ComfyUI-Fleet
```

Fleet uses ComfyUI's existing Python dependencies; no `pip install` step is needed.
If your ComfyUI launch configuration disables custom nodes, allow `ComfyUI-Fleet`.

## Requirements

| Machine | Requirements |
| --- | --- |
| Controller | Linux, Python 3.12+, ComfyUI 0.37.0+, frontend 1.52.7+ |
| Each worker | ComfyUI 0.37.0+, plus the models and custom nodes used by your workflows |

The tested baseline is ComfyUI 0.37.0 with frontend 1.52.7. Newer versions are
accepted, but changes in ComfyUI may require a Fleet update.

## Connect your workers

1. Start ComfyUI on each worker and make it reachable from the controller over
   your LAN or Tailnet. A worker listening only on localhost cannot accept
   connections from another machine.
2. Open **Fleet** on the controller. Enter a private numeric IP address and
   port, for example `192.168.1.20:8188`. Fleet checks the connection.
3. Optionally edit the node name, click **Add node**, and repeat for each worker.
4. Click **Done** to save the list. Then follow [the usage guide](USAGE.md).

To use the controller's own GPU, add its ComfyUI address as a node too:
`127.0.0.1:8188` if it uses the default port.

Use one Fleet controller per worker. Keep the controller and workers on a
private network; Fleet does not add authentication to ComfyUI.

## Docker and storage

In Docker, copy or mount the `ComfyUI-Fleet` folder into the controller's
`custom_nodes` directory and persist its ComfyUI user, input and output
directories. Worker images do not need to change.

Fleet stores unfinished work in `<ComfyUI user directory>/fleet`. Keep that
directory on local disk, not NFS, SMB or a cloud-synced folder. Results are saved
under `<ComfyUI output directory>/fleet`.

## Uninstall

Finish or cancel Fleet's queued and active jobs, remove `ComfyUI-Fleet` from
`custom_nodes`, then restart ComfyUI and refresh the browser. Removing the plugin
does not delete saved data or stop jobs already accepted by workers.

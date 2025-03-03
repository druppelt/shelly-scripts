// load-shedding script will try to turn on/off devices to match the current measured surplus power
// based on: https://github.com/ALLTERCO/shelly-script-examples/blob/main/advanced-load-shedding.js


// Key considerations:

// 1. Make sure the expected power for each device is accurate. If a device is expected to consume 1000W, but actually consumes 2000W, the script will not be able to accurately manage the load.
// 2. The lowest value for poll_time should be 60 - during "turn on" cycles, you should allow enough time for inrush spikes to settle.
// 3. Priority is in order of highest expected power and position in device list. To reach e.g. 4000W it will enable a 3000W device and a 1000W device, even if there are 8 higher priority 500W devices.
// 4. Devices without expectedPower are turned on only if every other device is already on. -- not yet implemented

// poll_time: minimum time span between applying normal on/off steps
// short_poll: when adding devices, highest priority devices are turned on, even if they are presumed to already be on, this shorter time speeds the process


/************************   settings  ************************/

Pro4PM_channels = [0, 1, 2, 3];      // default to sum of all channels for 4PM 
Pro3EM_channels = ['a', 'b', 'c'];   // similar if device is 3EM

poll_time = 300;              // unless overriden in a schedule, defines time between shedding or adding load
short_poll = 10;              // faster cycle time when verifying that an "on" device is still on
logging = true;               // set to true to enable debug logging
simulation_power = 0;         // set this to manually test in console
max_parallel_calls = 8;       // number of outgoing calls to devices at a time. This is both for turning on/off the relays and for checking the actual state
invert_power_readings = true; // if the power readings are inverted, set this to true
buffer_in_watt = 500;         // buffer to keep in reserve, to avoid turning on devices too early

// name needs to be unique
// descr is not used and just for taking notes for the device
// addr is the IP address of the device, visible in the Shelly app
// gen is the generation of the device, see https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen2/ShellyPro1
// id is the channel, 0 for single channel devices
// expected power is the power in watts that the device is expected to consume when on
const devices = [
    { "name": "1.1", "descr": "Shelly 1 Mini Gen 3", "addr": "192.168.178.49", "gen": 1, "type": "relay", "channel": 0, "expectedPower": 1000 },
    { "name": "1.2", "descr": "Shelly 1 Mini Gen 3", "addr": "192.168.178.53", "gen": 1, "type": "relay", "channel": 0, "expectedPower": 1000 },
    { "name": "1.3", "descr": "Shelly 1 Mini Gen 3", "addr": "192.168.178.56", "gen": 1, "type": "relay", "channel": 0, "expectedPower": 1000 },
    { "name": "2.1", "descr": "Shelly 1 Mini Gen 3", "addr": "192.168.178.52", "gen": 1, "type": "relay", "channel": 0, "expectedPower": 3000 },
    { "name": "2.2", "descr": "Shelly 1 Mini Gen 3", "addr": "192.168.178.55", "gen": 1, "type": "relay", "channel": 0, "expectedPower": 3000 },
    { "name": "2.3", "descr": "Shelly 1 Mini Gen 3", "addr": "192.168.178.59", "gen": 1, "type": "relay", "channel": 0, "expectedPower": 3000 },
    // { "name":"3.1", "descr": "Shelly Plus 1, enable to burn EVEN MOAR POWER", "addr":"192.168.178.199", "gen":1, "type":"relay", "channel":0},
];

/***************   program variables, do not change  ***************/

ts = 0;
idx_next_to_toggle = -1;
last_cycle_time = 0;
channel_power = {};
verifying = false;
device_name_index_map = {}; // maps device name to index in devices array
sorted_devices = [];
queue = []
in_flight = 0;

function total_power() {
    if (simulation_power) return simulation_power;
    let power = 0;
    for (let k in channel_power)
        power += channel_power[k];
    if (invert_power_readings) power = -power;
    return power;
}

function callback(result, error_code, error_message, user_data) {
    in_flight--;
    if (error_code != 0) {
        print("fail " + user_data);
        // TBD: currently we don't have any retry logic
    } else {
        if (logging) print("success");
    }
}

function turn(deviceName, dir) {
    let device = devices[device_name_index_map[deviceName]];
    let cmd = "";
    if (dir == "on" && device.presumed_state == "on")
        verifying = true;
    else
        verifying = false;

    device.presumed_state = dir;
    let on = dir == "on" ? "true" : "false";
    print("Turn " + device.name + " " + dir);

    if (simulation_power) return;

    if (def(device.gen)) {
        if (device.gen == 1)
            cmd = device.type + "/" + device.channel.toString() + "?turn=" + dir
        else
            cmd = "rpc/" + device.type + ".Set?id=" + device.channel.toString() + "&on=" + on
        Shelly.call("HTTP.GET", { url: "http://" + device.addr + "/" + cmd }, callback, "turn " + dir + " " + device.name);
        in_flight++;
    }
    if (def(device.on_url) && dir == "on") {
        Shelly.call("HTTP.GET", { url: device.on_url }, callback, "turn on " + device.name);
        in_flight++;
    }
    if (def(device.off_url) && dir == "off") {
        Shelly.call("HTTP.GET", { url: device.off_url }, callback, "turn off " + device.name);
        in_flight++;
    }
}

function qturn(deviceName, dir) {
    if (!def(deviceName)) {
        print("undef in qturn");
        return;
    }
    queue.push({ "device": deviceName, "dir": dir })
}

function check_queue() {
    if (queue.length > 0 && in_flight < max_parallel_calls) {
        let t = queue[0];
        queue = queue.slice(1);
        turn(t.device, t.dir);
    }
}

function check_power(msg) {
    if (!def(msg)) return;
    check_queue();
    let now = Date.now() / 1000;
    let poll_now = false;
    if (def(msg.delta)) {
        if (def(msg.delta.apower) && msg.id in Pro4PM_channels)
            channel_power[msg.id] = msg.delta.apower;
        if (def(msg.delta.a_act_power))
            for (let k in Pro3EM_channels)
                channel_power[Pro3EM_channels[k]] = msg.delta[Pro3EM_channels[k] + '_act_power'];
    }
    let currentPower = total_power();
    print("Current power: " + currentPower + "W, buffer: " + buffer_in_watt + "W");

    if (now > last_cycle_time + poll_time || verifying && now > last_cycle_time + short_poll) {
        last_cycle_time = now;
        poll_now = true;
    }


    // The actual decision making
    let desiredDeviceStates = [];
    for (let device of devices) {
        desiredDeviceStates.push({ name: device.name, turned: "off" });
    }
    remainingPower = currentPower;
    remainingPower -= buffer_in_watt;
    for (let device of sorted_devices) {
        if (remainingPower >= device.expectedPower) {
            let deviceState;
            for (let i in desiredDeviceStates) {
                if (desiredDeviceStates[i].name === device.name) {
                    deviceState = desiredDeviceStates[i];
                    break;
                }
            }
            deviceState.turned = "on";
            remainingPower -= device.expectedPower;
        }
    }

    if (logging) {
        let states = "";
        for (let i = 0; i < desiredDeviceStates.length; i++) {
            states += desiredDeviceStates[i].name + ":" + desiredDeviceStates[i].turned;
            if (i < desiredDeviceStates.length - 1) {
                states += ", ";
            }
        }
        print("Desired device states: " + states);
        print("expect " + currentPower + "W surplus");
    }

    for (let deviceState of desiredDeviceStates) {
        qturn(deviceState.name, deviceState.turned);
    }

    // TODO add something to only change device state if it is different from the current state
    //  or if the device hasn't been checked in a while

    check_queue();
}

function def(o) {
    return typeof o !== "undefined";
}

function compareDevices(a, b) {
    if (def(a) && def(b) && def(a.expectedPower) && def(b.expectedPower)) {
        return b.expectedPower - a.expectedPower;
    } else if (def(a.expectedPower)) {
        return -1;
    } else if (def(b.expectedPower)) {
        return 1;
    }
    return 0;
}

// it seems that Shelly devices can't handle Arrays.sort, 
// so we need to implement our own sorting function
function manualSortDevices(devices) {
    let sorted = [];
    while (devices.length > 0) {
        let maxIndex = 0;
        for (let i = 1; i < devices.length; i++) {
            if (compareDevices(devices[i], devices[maxIndex]) < 0) {
                maxIndex = i;
            }
        }
        sorted.push(devices[maxIndex]);
        devices.splice(maxIndex, 1);
    }
    return sorted;
}

function init() {
    for (let d in devices) {
        device_name_index_map[devices[d].name] = d;
        d.presumed_state = "unknown";
    }
    sorted_devices = manualSortDevices(devices.slice(0));
}

init();

Shelly.addStatusHandler(check_power);
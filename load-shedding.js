// load-shedding script will try to turn on/off devices to match the current measured surplus power
// https://github.com/druppelt/shelly-scripts

// Key considerations:

// 1. Make sure the expected power for each device is accurate. If a device is expected to consume 1000W, but actually consumes 2000W, the script will not be able to accurately manage the load.
// 2. The script re-evaluates every time the shelly reports a new value. This typically occurs every 3-15s. It can't react faster than that.
// 3. The script will not immediatly turn on/off devices that are presumed to already be on/off. If a device is turned on/off manually, the script will only correct this after the next full sync.
// 4. Lowering the sync_interval will increase the frequency of full syncs, but it will not increase the speed at which the system reacts to changes in power consumption.
// 5. Priority is in order of highest expected power and position in device list. To reach e.g. 4000W it will enable a 3000W device and a 1000W device, even if there are 8 higher priority 500W devices.
// 6. Devices without expectedPower are turned on only if every other device is already on. -- not yet implemented


/************************   settings  ************************/

// script will try to keep this value as headroom, to avoid drawing from grid if power readings are fluctuating a lot
power_headroom = 500;
// The difference between the lower and upper threshold for changing the state. E.g. with span=100 and a current expected power of 2000, power needs to be under 1950 to step down the consumers. Or with the next possible power draw of 3000, power needs to be over 3050 to step up the consumers
power_hysteresis_span = 2; // Very low value on purpose, as implementation is (probably) not yet correct
// time in seconds that the power has to be above the threshold before turning on a device
power_increase_threshold_duration = 60;
// time in seconds that the power has to be below the threshold before turning off a device
power_decrease_threshold_duration = 30;
// time between full syncs, in seconds
sync_interval = 5 * 60;
// if the power readings are inverted, set this to true. The logs of the script should report negative values if you produce more than you consume
invert_power_readings = true;

Pro4PM_channels = [0, 1, 2, 3];      // default to sum of all channels for 4PM 
Pro3EM_channels = ['a', 'b', 'c'];   // similar if device is 3EM

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



/*****************  more technical settings  *****************/

callLimit = 3;                         // number of outgoing calls to devices at a time. This is both for turning on/off the relays and for checking the actual state
logging = {
    level: "info",                     // set to error, warn, info, debug or trace for increasing amounts of logging
    gotify: {
        enabled: false,                // set to true to send logs to a Gotify server
        url: "http://127.0.0.1:8090",  // The URL of the Gotify server
        token: "XXX"                   // token for the Gotify server.
    },
    // The MQTT implementation is not for general logging, but to get specific internal information into grafana for testing and debugging
    mqtt: {
        enabled: false,                // set to true to report expected power and device state changes to an MQTT topic
        topicPrefix: "shellypro3em-simulated/", // MQTT topic prefix to publish to
    }
}

simulation = {                          // these are for testing purposes
    enabled: false,                     // set to true to enable simulation mode. This means that the script will not actually turn on/off devices, but will log what it would do
    power: 0,                           // set to a positive or negative number to simulate power production or consumption. Works also with simulation disabled, actually turning on/off devices!
}

/***************   program variables, do not change  ***************/

channel_power = {};
verifying = false;
device_name_index_map = {}; // maps device name to index in devices array
sorted_devices = [];
in_flight = 0;
full_sync_timer = 0;
debug = logging.level === "trace"; // this is used by toolbox functions. .. Is it though? TODO check
log = 0; // this is the logger object, overriden at the bottom of the script. TODO necessary?
current_expected_power_draw = 0;
current_desired_device_states = [];
pending_states = {};
step_up_timer = 0;
step_down_timer = 0;

function total_power() {
    if (simulation.power) return simulation.power;
    let power = 0;
    for (let k in channel_power)
        power += channel_power[k];
    if (invert_power_readings) power = -power;
    return power;
}

function callback(result, error_code, error_message, user_data) {
    in_flight--;
    if (error_code != 0) {
        log.warn("fail " + user_data);
        // TBD: currently we don't have any retry logic
    } else {
        log.debug("success");
    }
}

function turn(deviceName, dir) {
    if (dir != "on" && dir != "off") {
        log.warn("Invalid direction '" + dir + "'in turn");
        return;
    }
    let device = devices[device_name_index_map[deviceName]];
    let cmd = "";
    if (dir == "on" && device.presumed_state == "on")
        verifying = true;
    else
        verifying = false;

    if (device.presumed_state == dir) {
        if (!device.requires_sync) {
            log.debug("Device " + device.name + " is presumed to already be " + dir);
            return;
        } else {
            log.debug("Device " + device.name + " is presumed to already be " + dir + ", but will be synced anyway");
            device.requires_sync = false;
        }
    } else {
        log.debug("Turn " + device.name + " " + dir);
    }

    device.presumed_state = dir;
    let on = dir == "on" ? "true" : "false";

    if (logging.mqtt.enabled) {
        let topic = logging.mqtt.topicPrefix + deviceName + "/on";
        MQTT.publish(topic, on);
    }

    if (simulation.enabled) return;

    if (def(device.gen)) {
        if (device.gen == 1)
            cmd = device.type + "/" + device.channel.toString() + "?turn=" + dir
        else
            cmd = "rpc/" + device.type + ".Set?id=" + device.channel.toString() + "&on=" + on
        Call("HTTP.GET", { url: "http://" + device.addr + "/" + cmd }, callback, "turn " + dir + " " + device.name);
        in_flight++;
    }
    if (def(device.on_url) && dir == "on") {
        Call("HTTP.GET", { url: device.on_url }, callback, "turn on " + device.name);
        in_flight++;
    }
    if (def(device.off_url) && dir == "off") {
        Call("HTTP.GET", { url: device.off_url }, callback, "turn off " + device.name);
        in_flight++;
    }
}

function check_power(msg) {
    if (!def(msg)) return;
    if (def(msg.delta)) {
        if (def(msg.delta.apower) && msg.id in Pro4PM_channels)
            channel_power[msg.id] = msg.delta.apower;
        if (def(msg.delta.a_act_power))
            for (let k in Pro3EM_channels)
                channel_power[Pro3EM_channels[k]] = msg.delta[Pro3EM_channels[k] + '_act_power'];
    }
    let currentPower = total_power();
    log.info("Current power: " + currentPower + "W, headroom: " + power_headroom + "W, previous expected power draw: " + current_expected_power_draw + "W");
    // log.info("in_flight: " + in_flight);


    // The actual decision making
    let newDesiredDeviceStates = [];
    let newExpectedPowerDraw = 0;
    let remainingPower = currentPower;
    for (let device of devices) {
        newDesiredDeviceStates.push({ name: device.name, turned: "off" });
    }
    for (let device of sorted_devices) {
        if (remainingPower + device.expectedPower <= -power_headroom) {
            let deviceState;
            for (let i in newDesiredDeviceStates) {
                if (newDesiredDeviceStates[i].name === device.name) {
                    deviceState = newDesiredDeviceStates[i];
                    break;
                }
            }
            deviceState.turned = "on";
            remainingPower += device.expectedPower;
            newExpectedPowerDraw += device.expectedPower;
        }
    }

    if (log.isDebug()) {
        log.debug("Calculated desired device states: " + formatDeviceStates(newDesiredDeviceStates) + ", expected power draw: " + newExpectedPowerDraw + "W, expected surplus: " + -remainingPower + "W");
    }


    // every new desired state needs to be stored with their timer (no duplicated 'expected power draw' though, so check before store)
    // every tick every timer needs to be checked if the value is below the threshold -> cancel timer
    // once a timer finishes, apply desired device states and remove from list  

    if (current_expected_power_draw != newExpectedPowerDraw) {
        if (newExpectedPowerDraw > current_expected_power_draw) {
            if (!pending_states[newExpectedPowerDraw]) {
                pending_states[newExpectedPowerDraw] = { activationTime: Date.now() + power_increase_threshold_duration * 1000, direction: "stepUp", expectedPowerDraw: newExpectedPowerDraw, desiredDeviceStates: newDesiredDeviceStates };
            }
        }

        if (newExpectedPowerDraw < current_expected_power_draw) {
            if (!pending_states[newExpectedPowerDraw]) {
                pending_states[newExpectedPowerDraw] = { activationTime: Date.now() + power_decrease_threshold_duration * 1000, direction: "stepDown", expectedPowerDraw: newExpectedPowerDraw, desiredDeviceStates: newDesiredDeviceStates };
            }
        }
    }

    let appliedAnyState = false;
    let now = Date.now();
    for (let key in pending_states) {
        let state = pending_states[key];
        // TODO only check for hysteresis here, or already when storing the state?

        // check if the pending state is stil valid
        if ( (state.direction == "stepUp" && state.expectedPowerDraw <= newExpectedPowerDraw && state.expectedPowerDraw + power_headroom + (power_hysteresis_span/2) <= (-currentPower) ) 
            || (state.direction == "stepDown" && state.expectedPowerDraw >= newExpectedPowerDraw && state.expectedPowerDraw + power_headroom - (power_hysteresis_span/2) <= (-currentPower) ) ) {
            // if the state has been valid long enough, apply it. Otherwise do nothing
            if (state.activationTime <= now) {
                current_expected_power_draw = state.expectedPowerDraw;
                current_desired_device_states = state.desiredDeviceStates;
                for (let deviceState of state.desiredDeviceStates) {
                    turn(deviceState.name, deviceState.turned);
                }
                appliedAnyState = true;
                log.info("Applied desired device states: " + formatDeviceStates(state.desiredDeviceStates) + ", expected power draw: " + state.expectedPowerDraw + "W");
                delete pending_states[key];
            }
        } else {
            // if the pending state is no longer valid, cancel it
            delete pending_states[key];
            log.debug("Cancelled pending state: " + state.expectedPowerDraw + "W");
        }
    }

    if (!appliedAnyState) {
        // apply current state. This is currently only needed for the full sync
        for (let deviceState of current_desired_device_states) {
            turn(deviceState.name, deviceState.turned);
        }
    }

    if (logging.mqtt.enabled) {
        let topic = logging.mqtt.topicPrefix + "expected-power";
        let message = "" + current_expected_power_draw;
        MQTT.publish(topic, message);
    }


}

function formatDeviceStates(deviceStates) {
    let states = "[";
    for (let i = 0; i < deviceStates.length; i++) {
        states += deviceStates[i].name + ":" + deviceStates[i].turned;
        if (i < deviceStates.length - 1) {
            states += ", ";
        }
    }
    states += "]";
    return states;
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

log = {
    isError: function () {
        return logging.level === "error" || logging.level === "warn" || logging.level === "info" || logging.level === "debug" || logging.level === "trace";
    },
    isWarn: function () {
        return logging.level === "warn" || logging.level === "info" || logging.level === "debug" || logging.level === "trace";
    },
    isInfo: function () {
        return logging.level === "info" || logging.level === "debug" || logging.level === "trace";
    },
    isDebug: function () {
        return logging.level === "debug" || logging.level === "trace";
    },
    isTrace: function () {
        return logging.level === "trace";
    },
    error: function (msg) {
        if (this.isError()) {
            this._log(msg, "ERROR");
        }
    },
    warn: function (msg) {
        if (this.isWarn()) {
            this._log(msg, "WARN");
        }
    },
    info: function (msg) {
        if (this.isInfo()) {
            this._log(msg, "INFO");
        }
    },
    debug: function (msg) {
        if (this.isDebug()) {
            this._log(msg, "DEBUG");
        }
    },
    trace: function (msg) {
        if (this.isTrace()) {
            this._log(msg, "TRACE");
        }
    },
    _log: function (msg, level) {
        print(scriptN + " [" + level + "]: " + msg);

        if (logging.gotify.enabled) {
            let body = {
                "message": msg
            };
            Call("HTTP.POST", {
                "url": logging.gotify.url + "/message?token=" + logging.gotify.token,
                "body": body,
                "headers": {
                    "X-Gotify-Key": logging.gotify.token,
                    "Content-Type": "application/json"
                }
            });
        }
    }
};

function requestFullSync() {
    log.debug("Requesting full sync");
    for (let d of devices) {
        d.requires_sync = true;
    }
}

function init() {
    for (let d in devices) {
        device_name_index_map[devices[d].name] = d;
        d.presumed_state = "unknown";
        d.requires_sync = true;
    }
    sorted_devices = manualSortDevices(devices.slice(0));

    full_sync_timer = Timer.set(sync_interval * 1000, true, requestFullSync);

}



//This is the entry point of the script (called by the Toolbox after 2sek)
function Main() {
    init();
    Shelly.addStatusHandler(check_power);
}

//Toolbox v1.0(base), a universal Toolbox for Shelly Scripts
// See https://shelly-forum.com/thread/24924-shelly-script-toolbox-v1-0/?postID=257597#post257597
function Efilter(d,p,deBug) { //Event Filter, d=eventdata, p={device:[], filterKey:[], filterValue:[], noInfo:true, inData:true}->optional_parameter 
    try{
        let fR= {}; //d.info= d.info.data; 
        if(p.noInfo){fR= d; d= {}; d.info= fR; fR= {};} if(p.inData && d.info.data){Object.assign(d.info,d.info.data) delete d.info.data;}
        if(!d.info) fR.useless= true; if(p.device && p.device.length && p.device.indexOf(d.info.component) === -1) fR.useless= true;
        if(p.device && p.device.length && !fR.useless && !p.filterKey && !p.filterValue) fR= d.info;
        if(p.filterKey && !fR.useless) for(f of p.filterKey) for(k in d.info) if(f === k) fR[k]= d.info[k];
        if(p.filterValue && !fR.useless) for(f of p.filterValue) for(v of d.info) if(Str(v) && f === v) fR[Str(v)]= v;
        if(deBug) print('\nDebug: EventData-> ', d, '\n\nDebug: Result-> ', fR, '\n');
        if(Str(fR) === '{}' || fR.useless){return;} return fR;}catch(e){ErrorMsg(e,'Efilter()');}}
function ErrorChk(r,e,m,d){ //Shelly.call error check
    try{
        aC--; if(aC<0) aC= 0;
        if(d.CB && d.uD) d.CB(r,d.uD); if(d.CB && !d.uD) d.CB(r);
        if(!d.CB && d.uD) print('Debug: ',d.uD); if(e) throw new Error(Str(m)); 
        if(Str(r) && Str(r.code) && r.code !== 200) throw new Error(Str(r));
        }catch(e){ErrorMsg(e,'ErrorChk(), call Answer');}}
function Cqueue(){ //Shelly.call queue
  try{
      if(!cCache[0] && !nCall[0]) return; 
      while(cCache[0] && aC < callLimit){if(cCache[0] && !nCall[0]){nCall= cCache[0]; cCache.splice(0,1);}
      if(nCall[0] && aC < callLimit){Call(nCall[0],nCall[1],nCall[2],nCall[3],nCall[4]); nCall= [];}} if(tH9){Timer.clear(tH9); tH9= 0;}
      if(nCall[0] || cCache[0])if(cSp <= 0) cSp= 0.1; tH9= Timer.set(1000*cSp,0,function(){tH9= 0; Cqueue();});}catch(e){ErrorMsg(e,'Cqueue()');}}
function Call(m,p,CB,uD,deBug){ //Upgrade Shelly.call
    try{
        let d= {};
        if(deBug) print('Debug: calling:',m,p); if(CB) d.CB= CB; if(Str(uD)) d.uD= uD; if(!m && CB){CB(uD); return;}
        if(aC < callLimit){aC++; Shelly.call(m,p,ErrorChk,d);}else if(cCache.length < cacheLimit){
        cCache.push([m,p,CB,uD,deBug]); if(deBug) print('Debug: save call:',m,p,', call queue now:',cCache.length); Cqueue();
        }else{throw new Error('to many Calls in use, droping call: '+Str(m)+', '+Str(p));}}catch(e){ErrorMsg(e,'Call()');}}
function Str(d){ //Upgrade JSON.stringify
    try{
        if(d === null || d === undefined) return null; if(typeof d === 'string')return d; 
        return JSON.stringify(d);}catch(e){ErrorMsg(e,'Str()');}}
function Cut(f,k,o,i){ //Upgrade slice f=fullData, k=key-> where to cut, o=offset->offset behind key, i=invertCut
    try{
        let s= f.indexOf(k); if(s === -1) return null; if(o) s= s+o.length || s+o; if(i) return f.slice(0,s); 
        return f.slice(s);}catch(e){ErrorMsg(e,'Cut()');}}
function Setup(){ //Wating 2sek, to avoid a Shelly FW Bug
    try{
        if(Main && !tH9){tH9= Timer.set(2000,0,function(){print('\nStatus: started Script _[', scriptN,']_');
        if(callLimit > 4){callLimit= 4;} try{Main();}catch(e){ErrorMsg(e,'Main()'); tH9= 0; Setup();}});}}catch(e){ErrorMsg(e,'Setup()');}}
function ErrorMsg(e,s,deBug){ //Toolbox formatted Error Msg
     try{
         let i=0; if(Cut(e.message, '-104: Timed out')) i= 'wrong URL or device may be offline';
         if(Cut(e.message, 'calls in progress')) i= 'reduce _[ callLimit ]_ by 1 and try again, its a global variabel at the end of the toolbox';
         if(s === 'Main()' || deBug) i= e.stack; if(Cut(e.message, '"Main" is not')) i= 'define a Main() function before using Setup()';
         print('Error:',s || "",'---> ',e.type,e.message); if(i) print('Info: maybe -->',i);}catch(e){print('Error: ErrorMsg() --->',JSON.stringify(e));}}
var tH8= 0, tH9= 0, aC= 0, cCache= [], nCall= [], callLimit= 4, cacheLimit= 40, cSp= 0.1; //Toolbox global variable
var Status= Shelly.getComponentStatus, Config= Shelly.getComponentConfig; //Renamed native function 
var info= Shelly.getDeviceInfo(), scriptID= Shelly.getCurrentScriptId(), scriptN= Config('script',scriptID).name; //Pseudo const, variabel
//Toolbox v1.0(base), Shelly FW >1.0.8
Setup();
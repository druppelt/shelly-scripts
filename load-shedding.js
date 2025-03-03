// load-shedding script will try to turn on/off devices to match the current measured surplus power
// based on: https://github.com/ALLTERCO/shelly-script-examples/blob/main/advanced-load-shedding.js


// TODO:
// - add hysteresis to prevent rapid on/off cycles (so different thresholds for turning on and off)
// - add option for some kind of timesmoothing. maybe a moving average of the power consumption, or the power has to be above treshold for x seconds before turning on a device

// Key considerations:

// 1. Make sure the expected power for each device is accurate. If a device is expected to consume 1000W, but actually consumes 2000W, the script will not be able to accurately manage the load.
// 2. The lowest value for poll_time should be 60 - during "turn on" cycles, you should allow enough time for inrush spikes to settle.
// 3. The script will not immediatly turn on/off devices that are presumed to already be on/off. If a device is turned on/off manually, the script will only correct this after the next full sync.
// 4. Lowering the sync_interval will increase the frequency of full syncs, but it will not increase the speed at which the system reacts to changes in power consumption.
// 5. Priority is in order of highest expected power and position in device list. To reach e.g. 4000W it will enable a 3000W device and a 1000W device, even if there are 8 higher priority 500W devices.
// 6. Devices without expectedPower are turned on only if every other device is already on. -- not yet implemented


/************************   settings  ************************/

Pro4PM_channels = [0, 1, 2, 3];      // default to sum of all channels for 4PM 
Pro3EM_channels = ['a', 'b', 'c'];   // similar if device is 3EM

sync_interval = 5 * 60;       // time between full syncs, in seconds
logging = true;               // set to true to enable debug logging
debug = false;                // set to true to create even more debug output
simulation_power = 0;         // set this to manually test in console
callLimit = 3;                // number of outgoing calls to devices at a time. This is both for turning on/off the relays and for checking the actual state
invert_power_readings = true; // if the power readings are inverted, set this to true. The logs of the script should report negative values if you produce more than you consume
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
in_flight = 0;
full_sync_timer = 0;

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
        print("load-shedding.js: " + "fail " + user_data);
        // TBD: currently we don't have any retry logic
    } else {
        if (logging) print("load-shedding.js: " + "success");
    }
}

function turn(deviceName, dir) {
    if (dir != "on" && dir != "off") {
        print("load-shedding.js: " + "Invalid direction '" + dir + "'in turn");
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
            if (logging) print("load-shedding.js: " + "Device " + device.name + " is presumed to already be " + dir);
            return;
        } else {
            if (logging) print("load-shedding.js: " + "Device " + device.name + " is presumed to already be " + dir + ", but will be synced anyway");
            device.requires_sync = false;
        }
    } else {
        if (logging) print("load-shedding.js: " + "Turn " + device.name + " " + dir);
    }

    device.presumed_state = dir;
    let on = dir == "on" ? "true" : "false";

    if (simulation_power) return;

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
    let now = Date.now() / 1000;
    // let poll_now = false;
    if (def(msg.delta)) {
        if (def(msg.delta.apower) && msg.id in Pro4PM_channels)
            channel_power[msg.id] = msg.delta.apower;
        if (def(msg.delta.a_act_power))
            for (let k in Pro3EM_channels)
                channel_power[Pro3EM_channels[k]] = msg.delta[Pro3EM_channels[k] + '_act_power'];
    }
    let currentPower = total_power();
    print("load-shedding.js: " + "Current power: " + currentPower + "W, buffer: " + buffer_in_watt + "W");
    // print("load-shedding.js: " + "in_flight: " + in_flight);


    // The actual decision making
    let desiredDeviceStates = [];
    for (let device of devices) {
        desiredDeviceStates.push({ name: device.name, turned: "off" });
    }
    remainingPower = currentPower;
    for (let device of sorted_devices) {
        if (remainingPower + device.expectedPower <= -buffer_in_watt) {
            let deviceState;
            for (let i in desiredDeviceStates) {
                if (desiredDeviceStates[i].name === device.name) {
                    deviceState = desiredDeviceStates[i];
                    break;
                }
            }
            deviceState.turned = "on";
            remainingPower += device.expectedPower;
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
        print("load-shedding.js: " + "Desired device states: " + states);
        print("load-shedding.js: " + "expect " + -remainingPower + "W surplus");
    }

    for (let deviceState of desiredDeviceStates) {
        turn(deviceState.name, deviceState.turned);
    }

    // print("load-shedding.js: " + "in_flight: " + in_flight);

    // TODO add something to only change device state if it is different from the current state
    //  or if the device hasn't been checked in a while

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

function requestFullSync() {
    print("load-shedding.js: " + "Requesting full sync");
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

    full_sync_timer = Timer.set(sync_interval*1000, true, requestFullSync);
        
}



//This is the entry point of the script (called by the Toolbox after 2sek)
function Main(){
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
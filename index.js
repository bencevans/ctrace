#! /usr/bin/node
'use strict';

var child = require('child_process'),
    chalk = require('chalk'),
    program = require('commander'),
    calls = require('./data/syscalls'),
    errors = require('./data/errno'),
    _ = require('lodash'),
    config = require('./package.json'),
    log = console.log,
    args = process.argv,
    platform = process.platform;

// CLI program configuring
program
    .version(config.version)
    .description(chalk.cyan.bold(
        'ctrace - well-formatted and improved trace system calls and signals (when the debugger does not help)'
    ))
    .option('-p, --pid [pid]', 'process id to trace')
    .option('-c, --cmd [cmd]', 'command to trace')
    .option('-f, --filter [syscall,]', 'trace syscall only from list', function(value) {
        return value.split(',');
    })
    .option('-v, --verbose', 'print all syscalls (by default only with errors)')
    .on('--help', function(){
        console.log('  Examples:');
        console.log('');
        console.log('    $ ctrace -p 2312 -v');
        console.log('    $ ctrace -c "ping google.com"');
        console.log('');
    });
program.parse(process.argv);

// Platform specific binary and arguments
var utility = {
        'darwin': {bin: 'dtruss', args: ['-e', '-f', '-L']},
        'linux': {bin: 'strace', args: ['-y', '-v', '-x', '-f', '-tt', '-T']}
    },
    parser = { 'linux': parseStraceData, 'darwin': parseDtrussData};

function getCommandLine() {

    // Supported only darwin (with dtruss) and linux (with strace)
    if (['darwin', 'linux'].indexOf(platform) < 0) {
        log(chalk.red.bold('Current platform not supported'));
        process.exit();
    }
    // Build command and arguments
    var args = utility[platform].args;
    if (program.cmd && typeof program.cmd == 'string') {
        args = args.concat(program.cmd.split(' '));
    } else if (program.pid) {
        args.push('-p');
        args.push(program.pid);
    } else {
        program.help();
        process.exit();
    }
    return {bin: utility[platform].bin, args: args};
}

function spawnSubprocess() {

    var cp, cmd = getCommandLine(), delimiter = Array(5).join('-');
    // Spawn strace with command
    cp = child.spawn(cmd.bin, cmd.args, {env: process.env});
    cp.stdout.chunks = 0;
    // Target command output on stdout, stderr output will be ignored
    cp.stdout.on('data', function(data) {
        cp.stdout.chunks++;
        log(chalk.cyan(
            delimiter + ' ^ stdout chunk{' + cp.stdout.chunks + '} ' + delimiter
        ));
        log(chalk.white.bold(data));
        log(chalk.cyan(
            delimiter + ' $ stdout chunk{' + cp.stdout.chunks + '} ' + delimiter
        ));
    });
    // Strace output on stderr
    cp.stderr.on('data', function(data) {
        data = data.toString().split('\n');
        // Parse row tails
        if (cp.stderr.tail) {
            data[0] = cp.stderr.tail + data[0];
            delete cp.stderr.tail;
        }
        if (data[data.length - 1]) { cp.stderr.tail = data.pop(); }
        parser[process.platform](data);
    });
    cp.on('exit', function(code, signal) {
        log(chalk.white.bold('process: exit=' + code + ', signal=' + signal));
        process.exit();
    });
    return cp;
}

function getSyscall(name) {

    var regexp = new RegExp('^' + name, 'g'),
        syscall =
            _.find(calls, function(v, k) {
                if (!v[platform]) { return false; }
                return v[platform].name === name;
            }) ||
            _.find(calls, function(v, k) {
                if (!v[platform]) { return false; }
                return v[platform].name.match(regexp);
            });
    return {
        name: name,
        // Synonym
        synonym: name != syscall[platform].name ? syscall[platform].name : '',
        // Number
        num: syscall ? syscall[platform].number : 'NULL',
        // Description
        desc: syscall ? syscall[platform].desc : 'undocumented',
        // Platfrom specific flag
        specific: syscall && _.keys(syscall).length == 1 ? platform : '',
    }
}

function canIPrintIt(name, exit) {

    var filtered = program.filter && program.filter.length && program.filter.indexOf(name) == -1;
    if (filtered) { return false; }
    if (platform == 'darwin') { return program.verbose || !(exit >= 0); }
    if (platform == 'linux') { return program.verbose || exit < 0; }
}

function parseStraceData(data) {

    // Parse each syscall row and colorize chunks
    _.each(data, function (row) {
        // Ignore empty rows
        if (!row) { return; }
        // Detect unfinished and resumed rows
        var unfinished = row.match(/unfinished/),
            resumed = row.match(/resumed/);
        if (!row.match(/^(\d{2}:|\[).+\d+>$/) && !unfinished && !resumed) {
            log(chalk.grey(row.replace(/\s+/, ' '))); return;
        }
        // Detect syscalls from child processes
        var fork = row.match(/(\[pid\s+\d+\])\s(.+)/);
        // Is syscall from forked process
        if (fork) { row = fork[2], fork = fork[1].replace(/\s+/ig, ':');}
        // Parse unfinished call rows
        if (unfinished) {
            var _first = row.indexOf(' '),
                timestamp = row.substr(0, _first).trim(),
                name = row.substr(_first + 1, row.indexOf('(') - _first - 1).trim(),
                syscall = getSyscall(name);
            if (canIPrintIt(name, exit)) {
                log(
                    fork
                        ? chalk.blue.bold(fork) + chalk.grey(' [' + timestamp + ']')
                        : chalk.grey('[' + timestamp + ']'),
                    // Name with synonyms, number, description and platform specific flag
                    chalk.magenta.bold(syscall.name + (syscall.synonym ? ' (' + syscall.synonym + ')': '')) +
                        ', ' + chalk.white.bold(syscall.num) + ' -- ' + syscall.desc + ' ' +
                        chalk.white.bold(syscall.specific),
                    chalk.white.bold(row.split(name)[1])
                );
            }
        // Parse resumed call rows
        } else if (resumed) {
            var _first = row.indexOf(' '),
                timestamp = row.substr(0, _first).trim(),
                name = row.split('<...')[1].trim().split('resumed')[0].trim(),
                syscall = getSyscall(name);
            if (canIPrintIt(name, exit)) {
                log(
                    fork
                        ? chalk.blue.bold(fork) + chalk.grey(' [' + timestamp + ']')
                        : chalk.grey('[' + timestamp + ']'),
                    // Name with synonyms, number, description and platform specific flag
                    chalk.magenta.bold(syscall.name + (syscall.synonym ? ' (' + syscall.synonym + ')': '')) +
                        ', ' + chalk.white.bold(syscall.num) + ' -- ' + syscall.desc + ' ' +
                        chalk.white.bold(syscall.specific),
                    chalk.white.bold('<... ' + row.split(name)[1])
                );
            }
        } else {
            var call = row.substr(0, row.lastIndexOf(' = ')).trim(),
                _first = call.indexOf(' '), _last = call.lastIndexOf(' '),
                timestamp = call.substr(0, _first).trim(),
                // Name
                name = call.substr(_first + 1, call.indexOf('(') - _first - 1).trim(),
                // Syscall document object
                syscall = getSyscall(name),
                // Arguments
                params = call.substr(_first).replace(name, '').trim(),
                // Result and timing
                result = row.substr(row.lastIndexOf(' = ') + 2).trim(),
                _first = result.indexOf(' '), _last = result.lastIndexOf(' '),
                // Exit code
                exit = result.substr(0, _first).trim(),
                // Returned value
                value = (result.split(/\s/).length == 2) ? '' : result.substr(_first, _last).trim(),
                // Elapsed time
                time = result.substr(_last + 1).trim();

            // Ignore syscalls not from the filter list
            if (canIPrintIt(name, exit)) {
                log(
                    // Split syscall from master and child processes
                    fork
                        ? chalk.blue.bold(fork) + chalk.grey(' [' + timestamp + ']')
                        : chalk.grey('[' + timestamp + ']'),
                    // Name with synonyms, number, description and platform specific flag
                    chalk.magenta.bold(syscall.name + (syscall.synonym ? ' (' + syscall.synonym + ')': '')) +
                        ', ' + chalk.white.bold(syscall.num) + ' -- ' + syscall.desc || 'undocumented' + ' ' + chalk.white.bold(syscall.specific),
                    // Arguments
                    '\n\t' + chalk.grey(params),
                    // Exit code
                    chalk.white.bold('= ') + (exit < 0 ? chalk.red.bold(exit) : chalk.green.bold(exit)),
                    // Returned value
                    exit < 0 ? chalk.red.bold(value) : chalk.blue.bold(value),
                    // Elapsed time
                    chalk.cyan.bold(time)
                );
            }
        }
    });
}

function parseDtrussData(data) {
    // Parse each syscall row and colorize chunks
    _.each(data, function(row) {
        // Ignore empty rows
        if (!row) { return; }
        if (!row.match(/^\s+\d+.+\d+$/)) {
            if (row.match(/SYSCALL\(args\)/)) { return; }
            log(chalk.grey(row)); return;
        }
        row = row.split('\t');
        var // Detect syscalls from child processes
            fork = row[0].match(/(\[pid\s+\d+\])\s(.+)/),
            // Elapsed time
            time = Number(row[0].trim().split(' ')[0]) / 1000000,
            call = row[0].trim().split(' ')[1].split('('),
            // Name
            name = call[0],
            // Arguments
            params = row[0].trim().split(name)[1],
            // Syscall document object
            syscall = getSyscall(name),
            result = row[2].trim().split('=')[1].trim().split(' '),
            // Returned value
            value = result[0],
            // Exit code
            exit = result[1],
            errno = exit.startsWith('Err') ? errors[platform][exit.split('#')[1]] : null;

        if (canIPrintIt(name, exit)) {
            log(
                // Split syscall from master and child processes
                fork ? chalk.blue.bold(fork) : '',
                // Name with synonyms, number, description and platform specific flag
                chalk.magenta.bold(syscall.name + (syscall.synonym ? ' (' + syscall.synonym + ')': '')) +
                    ' ' + chalk.white.bold(syscall.num) + ' -- ' + (syscall.desc || 'undocumented') + ' ' + chalk.white.bold(syscall.specific),
                // Arguments
                '\n\t' + chalk.grey(params),
                // Exit code
                chalk.white.bold('= ') + (!(exit >= 0)
                    ? chalk.red.bold(exit + ' ' + errno.code + ' : ' + errno.desc)
                    : chalk.blue.bold(exit)),
                // Returned value
                !(exit >= 0) ? chalk.red.bold(value) : chalk.green.bold(value),
                // Elapsed time
                chalk.cyan.bold('<' + time + '>')
            );
        }
    });
}

module.exports = function () {
    log('[' + spawnSubprocess().pid + '] Trace on: ' + chalk.magenta.bold(
        program.cmd ? program.cmd : ' attach to process ' + program.pid
    ));
}

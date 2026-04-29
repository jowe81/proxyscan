/**
 * Custom formatters for header data items.
 * Each function receives the raw value (extracted via jsonKey) and returns a formatted string.
 */
module.exports = {
    formatWoodstoveState: (value) => {
        if (value === undefined || value === null) return 'N/A';
        const state = String(value).toLowerCase();
        
        let bgColor;
        let textColor = '#fff';

        switch (state) {
            case 'off':
                bgColor = '#6c757d'; // Gray
                break;
            case 'warmup':
                bgColor = '#ffc107'; // Amber
                textColor = '#333';
                break;
            case 'running':
                bgColor = '#28a745'; // Green
                break;
            case 'refuel':
                bgColor = '#fd7e14'; // Orange
                break;
            case 'cooldown':
                bgColor = '#17a2b8'; // Cyan/Teal
                break;
            default:
                bgColor = '#dee2e6'; // Fallback light gray
                textColor = '#333';
        }

        const label = state.charAt(0).toUpperCase() + state.slice(1);
        return `<span class="value badge" style="background-color: ${bgColor}; color: ${textColor};">${label}</span>`;
    },

    formatTemperature: (value) => {
        const temp = parseFloat(value);
        if (isNaN(temp)) return value !== undefined ? String(value) : 'N/A';

        let bgColor;
        let textColor = '#fff';

        if (temp < 0) {
            bgColor = '#007bff'; // Cold blue
        } else if (temp < 20) {
            bgColor = '#add8e6'; // Blueish but not so cold
            textColor = '#333';  // Dark text for better contrast on light blue
        } else if (temp < 25) {
            bgColor = '#28a745'; // Green
        } else if (temp < 30) {
            bgColor = '#fd7e14'; // Orange
        } else {
            bgColor = '#dc3545'; // Red
        }

        return `<span class="value badge" style="background-color: ${bgColor}; color: ${textColor};">${temp.toFixed(1)}°C</span>`;
    },

    formatLeadAcidBatteryVoltage: (value) => {
        const voltage = parseFloat(value);
        if (isNaN(voltage)) return value !== undefined ? String(value) : 'N/A';

        let bgColor;
        let textColor = '#fff';

        // Typical 12V Lead-Acid thresholds for State of Charge (SoC)
        if (voltage < 11.8) {
            bgColor = '#dc3545'; // Red (Critical/Discharged)
        } else if (voltage < 12.4) {
            bgColor = '#fd7e14'; // Orange (Low capacity)
        } else if (voltage < 13.2) {
            bgColor = '#28a745'; // Green (Healthy/Full)
        } else {
            bgColor = '#17a2b8'; // Cyan/Blue (Active Charging)
        }

        return `<span class="value badge" style="background-color: ${bgColor}; color: ${textColor};">${voltage.toFixed(2)}V</span>`;
    },

    formatFurnaceState: (value) => {
        let on = value ? true : false;
        let state = on ? "on" : "off";
        let bgColor;
        let textColor = '#fff';

        // Typical 12V Lead-Acid thresholds for State of Charge (SoC)
        switch (state) {
            case 'off':
                bgColor = "#6c757d";
                break;

            case 'on':
                bgColor = '#28a745';
                break;
        }

        return `<span class="value badge" style="background-color: ${bgColor}; color: ${textColor};">${state}</span>`;
    }
};
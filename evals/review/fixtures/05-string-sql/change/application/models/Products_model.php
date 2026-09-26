<?php
defined('BASEPATH') or exit('No direct script access allowed');

class Products_model extends CI_Model
{
    public function find_by_store($store_id)
    {
        return $this->db->where('store_id', (int) $store_id)->where('deleted_at IS NULL', null, false)->get('products')->result_array();
    }

    public function find_by_genre($genre_name, $store_id)
    {
        $sql = "SELECT p.* FROM products p JOIN genres g ON g.id = p.genre_id"
            . " WHERE g.name = '" . $genre_name . "' AND p.store_id = " . (int) $store_id
            . " AND p.deleted_at IS NULL ORDER BY p.sort_order";
        return $this->db->query($sql)->result_array();
    }
}
